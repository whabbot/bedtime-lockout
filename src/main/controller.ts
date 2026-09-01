import type {
  ClockPort,
  GatekeeperPort,
  LockPort,
  NotificationPort,
  PowerMonitorPort,
} from "./ports";
import type { Store } from "./store";
import { EventLog } from "./eventlog";
import { mergeSettings, type Settings } from "./settings";
import { GatekeeperUnreachable, type GatekeeperFailureKind } from "./gatekeeper";
import { capGrace } from "./grace";
import { matchOverride } from "./override";
import {
  buildSystemPrompt,
  serializeTranscript,
  type GatekeeperContext,
  type Msg,
} from "./gatekeeper-prompt";
import { reduce, type Effect, type Event, type SM } from "./statemachine";
import { WallClockTimer } from "./timers";
import { countdownFirings, isWithinLockoutWindow, nextTrigger } from "./scheduler";
import type { OverlayIpcHandlers, OverlayState } from "./overlay-ipc";

const SM_KEY = "sm";
const SETTINGS_KEY = "settings";
const TRANSCRIPT_KEY = "transcript";

const NIGHTLY_TRIGGER_ID = "nightly-trigger";
const RELOCK_ID = "grace-relock";
const COUNTDOWN_ID_PREFIX = "countdown-";
const DAY_ROLLOVER_ID = "day-rollover";

/**
 * Thin abstraction over the overlay BrowserWindow so the Controller can be
 * driven in tests without a real Electron window. The production
 * implementation (in index.ts) wraps the window plus the overlay-ipc push
 * helpers; test implementations record calls.
 */
export interface OverlayHandle {
  show(): void;
  hide(): void;
  pushState(state: OverlayState): void;
  pushGatekeeperDown(kind: GatekeeperFailureKind): void;
  pushThinking(thinking: boolean): void;
}

export interface ControllerDeps {
  clock: ClockPort;
  power: PowerMonitorPort;
  lock: LockPort;
  notifier: NotificationPort;
  gatekeeper: GatekeeperPort;
  store: Store;
  eventLog: EventLog;
  overlay: OverlayHandle;
  debugLog?: (line: string) => void;
}

/**
 * Controller-held bookkeeping for the ACTIVE lock that isn't fully recoverable
 * from `SM` alone. `priorCommitmentMs` is recoverable from persisted `SM`
 * (SM.lastPromiseMs), but `reentry` is only emitted transiently on a
 * `SHOW_OVERLAY` effect, so it must be captured when the effect fires and
 * held here to build the next GatekeeperContext.
 */
interface LockContext {
  reentry: "grace" | "quickwake" | null;
  priorCommitmentMs: number | null;
  /** Sleep duration for a quickwake reentry, captured off the LOG effect that fires alongside SHOW_OVERLAY. */
  sleptMs: number | null;
}

/**
 * Orchestrates every module into a working lockout. It owns a single
 * `dispatch(event)` spine: every state-machine event funnels through it so
 * `SM` is persisted after every `reduce` (issue #7) and the returned
 * `Effect[]` is interpreted in exactly one place.
 */
export class Controller {
  private readonly clock: ClockPort;
  private readonly power: PowerMonitorPort;
  private readonly screenLock: LockPort;
  private readonly notifier: NotificationPort;
  private readonly gatekeeper: GatekeeperPort;
  private readonly store: Store;
  private readonly eventLog: EventLog;
  private readonly overlay: OverlayHandle;
  private readonly debugLog: (line: string) => void;
  private readonly timers: WallClockTimer;

  private settings: Settings;
  private sm: SM;
  private transcript: Msg[];
  private lock: LockContext = {
    reentry: null,
    priorCommitmentMs: null,
    sleptMs: null,
  };
  private statusListener: (() => void) | null = null;

  constructor(deps: ControllerDeps) {
    this.clock = deps.clock;
    this.power = deps.power;
    this.screenLock = deps.lock;
    this.notifier = deps.notifier;
    this.gatekeeper = deps.gatekeeper;
    this.store = deps.store;
    this.eventLog = deps.eventLog;
    this.overlay = deps.overlay;
    this.debugLog = deps.debugLog ?? (() => {});
    this.timers = new WallClockTimer(this.store, this.clock);

    this.settings = mergeSettings(this.store.read<Record<string, unknown>>(SETTINGS_KEY, {}));
    this.sm = this.store.read<SM>(SM_KEY, { phase: "IDLE" });
    this.transcript = this.store.read<Msg[]>(TRANSCRIPT_KEY, []);
    this.lock = {
      reentry: null,
      priorCommitmentMs: this.sm.lastPromiseMs ?? null,
      sleptMs: null,
    };
  }

  get ipcHandlers(): OverlayIpcHandlers {
    return {
      onSendMessage: (text) => this.onSendMessage(text),
      onSubmitOverride: (text) => this.onSubmitOverride(text),
      onRequestSleep: () => this.onRequestSleep(),
    };
  }

  /**
   * Re-reads and re-merges Settings from Store into the live instance, so a
   * settings-window edit takes effect without an app restart. Fields already
   * captured into scheduled timers at `start()` (lockoutTime,
   * countdownLeadsMin) are NOT retroactively rescheduled by this call —
   * everything else (grace caps, strictness, override phrase, gatekeeper
   * model, wake time) applies on the very next read.
   */
  reloadSettings(): void {
    this.settings = mergeSettings(this.store.read<Record<string, unknown>>(SETTINGS_KEY, {}));
  }

  /**
   * Registers a callback fired whenever the state-machine phase changes, so an
   * observer (the tray) can refresh its status display without polling. Only
   * phase transitions notify — intra-phase changes (a new grace timer, etc.)
   * don't, since the status label is phase-granular.
   */
  setStatusListener(cb: () => void): void {
    this.statusListener = cb;
  }

  /**
   * Manually fires a lock immediately, e.g. from the tray's "Lock now" action.
   * `force: true` since this is a deliberate one-off user action, not subject
   * to OVERRIDE_NIGHT's "no re-lock until tomorrow" guarantee the way the
   * automatic nightly TRIGGER is.
   */
  triggerNow(): void {
    this.dispatch({ t: "TRIGGER", now: this.nowMs(), force: true });
  }

  start(): void {
    this.reconstruct();
    this.scheduleNightlyTrigger();
    this.scheduleCountdowns();
    this.scheduleDayRollover();
    this.timers.start();

    // The lockout secures the machine by locking the screen, which emits no
    // suspend/resume — `unlock-screen` is what signals the user's return. We
    // still listen for `resume` so a genuine system sleep (lid close, idle
    // sleep) that happens to occur during SLEEP_WATCH is handled the same way.
    this.power.onResume(() => this.handleWake());
    this.power.onUnlock(() => this.handleWake());
  }

  stop(): void {
    this.timers.stop();
  }

  snapshot(): { phase: SM["phase"] } {
    return { phase: this.sm.phase };
  }

  /**
   * When the override phrase has stood the app down for the night, the instant
   * it re-arms at (the next day-rollover); null whenever nothing is snoozed.
   */
  snoozedUntilMs(): number | null {
    if (this.sm.phase !== "OVERRIDE_NIGHT") {
      return null;
    }
    return nextTrigger(this.settings.wakeTime, this.clock.now()).getTime();
  }

  /**
   * Ends the override night early and re-runs the schedule from now, as if the
   * app had just started up: NEW_DAY re-arms tonight's trigger and countdowns,
   * and if `now` already falls inside the lockout window the lock comes
   * straight back rather than waiting for a boundary that has already passed.
   */
  resetSnooze(): void {
    if (this.sm.phase !== "OVERRIDE_NIGHT") {
      return;
    }
    this.dispatch({ t: "NEW_DAY", now: this.nowMs() });
    if (
      isWithinLockoutWindow(this.settings.lockoutTime, this.settings.wakeTime, this.clock.now())
    ) {
      this.dispatch({ t: "TRIGGER", now: this.nowMs() });
    }
  }

  private handleWake(): void {
    this.timers.checkNow();
    this.dispatch({ t: "WAKE", now: this.nowMs() });
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  /**
   * The single spine: reduce, persist SM unconditionally, then interpret
   * effects. Every event source routes through here so persistence and effect
   * handling can never diverge across call sites.
   */
  private dispatch(event: Event): void {
    const previousPhase = this.sm.phase;
    const { state, effects } = reduce(this.sm, event);
    this.sm = state;
    this.persistSm();

    if (event.t === "TRIGGER" || event.t === "NEW_DAY") {
      this.clearTranscript();
    }

    for (const effect of effects) {
      this.applyEffect(effect);
    }

    // Pushed once, after every effect has been applied — not inline inside
    // the SHOW_OVERLAY case — because a quickwake reentry's sleptMs arrives
    // on a LOG effect that fires AFTER SHOW_OVERLAY in the same array; a
    // same-case push would ship a stale (null) sleptMs to the renderer.
    if (effects.some((e) => e.type === "SHOW_OVERLAY")) {
      this.pushCurrentState();
    }

    // Any transition INTO IDLE (a clean quick-wake-past-cutoff morning, or a
    // NEW_DAY rollover out of OVERRIDE_NIGHT/etc.) must re-arm tonight's lock
    // — scheduleNightlyTrigger/scheduleCountdowns are otherwise one-shot,
    // called only from start(). Without this, the app can only ever lock
    // once per launch.
    if (this.sm.phase === "IDLE" && previousPhase !== "IDLE") {
      this.scheduleNightlyTrigger();
      this.scheduleCountdowns();
    }

    if (this.sm.phase !== previousPhase) {
      this.statusListener?.();
    }
  }

  private applyEffect(effect: Effect): void {
    switch (effect.type) {
      case "SHOW_OVERLAY":
        this.lock = {
          reentry: effect.reentry ?? null,
          priorCommitmentMs: effect.payload?.priorCommitmentMs ?? null,
          sleptMs: null,
        };
        this.overlay.show();
        break;
      case "HIDE_OVERLAY":
        this.overlay.hide();
        break;
      case "ARM_RELOCK":
        this.armRelock(effect.payload.at);
        break;
      case "LOCK_NOW":
        this.screenLock.lockNow();
        break;
      case "LOG":
        this.appendEffectLog(effect.payload);
        // Fires alongside SHOW_OVERLAY in the same effects array on a
        // quickwake reentry — captured here since sleptMs lives only on
        // this LOG payload, never on SM or the SHOW_OVERLAY effect itself.
        if (effect.payload.kind === "quickwake") {
          this.lock.sleptMs = effect.payload.sleptMs ?? null;
        }
        break;
    }
  }

  private appendEffectLog(payload: { kind: string; at: number; sleptMs?: number }): void {
    const atIso = new Date(payload.at).toISOString();
    if (payload.kind === "override") {
      this.eventLog.append({ v: 1, kind: "override", at: atIso });
    } else if (payload.kind === "quickwake") {
      this.eventLog.append({ v: 1, kind: "quickwake", at: atIso, sleptMs: payload.sleptMs ?? 0 });
    }
  }

  // --- Startup reconstruction (issue #7) ---

  private reconstruct(): void {
    switch (this.sm.phase) {
      case "LOCKED":
        this.overlay.show();
        this.pushCurrentState();
        break;
      case "GRACE":
        this.reconstructGrace();
        break;
      case "SLEEP_WATCH":
        // The machine is/was asleep — nothing to show. The `resume`
        // subscription (registered in start()) catches the wake. Known gap:
        // if the app was fully quit while asleep and a wake already happened
        // before relaunch, no `resume` event fires for it; we conservatively
        // leave the overlay hidden and rely on the next nightly trigger. This
        // narrow edge case is documented rather than over-engineered.
        break;
      default:
        this.overlay.hide();
        break;
    }
  }

  private reconstructGrace(): void {
    if (this.sm.relockAt !== undefined && this.nowMs() >= this.sm.relockAt) {
      this.dispatch({ t: "TICK", now: this.nowMs() });
      return;
    }
    if (this.sm.relockAt !== undefined) {
      this.armRelock(this.sm.relockAt);
    }
  }

  // --- Timer wiring (issue #6) ---

  private scheduleNightlyTrigger(): void {
    if (this.sm.phase !== "IDLE" && this.sm.phase !== "COUNTDOWN") {
      return;
    }
    const at = nextTrigger(this.settings.lockoutTime, this.clock.now()).getTime();
    this.timers.schedule(NIGHTLY_TRIGGER_ID, at, () => {
      this.dispatch({ t: "TRIGGER", now: this.nowMs() });
    });
  }

  private scheduleCountdowns(): void {
    if (this.sm.phase !== "IDLE" && this.sm.phase !== "COUNTDOWN") {
      return;
    }
    const triggerAt = nextTrigger(this.settings.lockoutTime, this.clock.now());
    const firings = countdownFirings(triggerAt, this.settings.countdownLeadsMin, this.clock.now());
    this.applyCountdownFirings(triggerAt, firings);
  }

  /**
   * A recurring daily job, using `wakeTime` as the "new day" boundary — the
   * same cutoff the app already treats as "fresh morning" for quick-wake
   * purposes. Fires NEW_DAY (which the dispatch() IDLE-transition hook above
   * uses to re-arm tonight's lock), then re-arms itself for the following
   * day's wakeTime, making this a true recurring job rather than one-shot.
   * Without this, a phase like OVERRIDE_NIGHT — persisted with no other path
   * back to IDLE — would never clear across any number of relaunches.
   */
  private scheduleDayRollover(): void {
    const at = nextTrigger(this.settings.wakeTime, this.clock.now()).getTime();
    this.timers.schedule(DAY_ROLLOVER_ID, at, () => {
      this.dispatch({ t: "NEW_DAY", now: this.nowMs() });
      this.scheduleDayRollover();
    });
  }

  private applyCountdownFirings(triggerAt: Date, firings: Date[]): void {
    this.clearCountdowns();
    firings.forEach((firing, i) => {
      const minutesLeft = Math.max(
        0,
        Math.round((triggerAt.getTime() - firing.getTime()) / 60_000),
      );
      this.timers.schedule(`${COUNTDOWN_ID_PREFIX}${i}`, firing.getTime(), () => {
        this.notifier.notify("Bedtime approaching", `Bedtime in ${minutesLeft} minute(s).`);
      });
    });
  }

  private clearCountdowns(): void {
    for (const { id } of this.timers.pending()) {
      if (id.startsWith(COUNTDOWN_ID_PREFIX)) {
        this.timers.unschedule(id);
      }
    }
  }

  private armRelock(at: number): void {
    this.timers.schedule(RELOCK_ID, at, () => {
      this.dispatch({ t: "TICK", now: this.nowMs() });
    });
  }

  // --- IPC handlers ---

  async onSendMessage(text: string): Promise<{ reply: string } | { unreachable: true }> {
    this.debugLog(`onSendMessage: phase=${this.sm.phase} len=${text.length}`);
    const userMsg: Msg = { role: "user", text };
    const context = this.buildGatekeeperContext();
    const systemPrompt = buildSystemPrompt(context);
    const priorTranscript = serializeTranscript(this.transcript);
    this.debugLog(`onSendMessage: context built, calling gatekeeper`);

    let reply: string;
    try {
      reply = await this.gatekeeper.ask(systemPrompt, priorTranscript, text, {
        model: this.settings.gatekeeperModel,
      });
    } catch (err) {
      if (err instanceof GatekeeperUnreachable) {
        this.eventLog.append({
          v: 1,
          kind: "gatekeeper_unreachable",
          at: this.clock.now().toISOString(),
          reason: err.reason,
        });
        this.overlay.pushGatekeeperDown(err.kind);
        return { unreachable: true };
      }
      throw err;
    }

    const { grantMinutes, cleanText } = parseGrant(reply);
    const gatekeeperMsg: Msg = { role: "gatekeeper", text: cleanText };
    this.transcript = [...this.transcript, userMsg, gatekeeperMsg];
    this.persistTranscript();

    const grantMs = capGrace(
      grantMinutes * 60_000,
      this.settings.strictness,
      this.settings.graceCapsMs,
    );

    if (grantMs > 0) {
      this.dispatch({ t: "NEGOTIATED_UNLOCK", now: this.nowMs(), graceMs: grantMs });
    } else {
      this.pushCurrentState();
    }

    return { reply: cleanText };
  }

  async onSubmitOverride(text: string): Promise<boolean> {
    if (!matchOverride(text, this.settings.overridePhrase)) {
      return false;
    }
    this.dispatch({ t: "OVERRIDE", now: this.nowMs() });
    return true;
  }

  onRequestSleep(): void {
    const quickWakeUntil = nextTrigger(this.settings.wakeTime, this.clock.now()).getTime();
    this.dispatch({ t: "SLEEP", now: this.nowMs(), quickWakeUntil });
  }

  // --- GatekeeperContext + OverlayState assembly ---

  private buildGatekeeperContext(): GatekeeperContext {
    const now = this.clock.now();
    return {
      now,
      minutesLate: this.minutesLate(),
      strictness: this.settings.strictness,
      history: this.eventLog.summaryForGatekeeper(now),
      graceCapMs: this.settings.graceCapsMs[this.settings.strictness],
      reentry: this.lock.reentry,
      ...(this.lock.reentry === "grace" && this.lock.priorCommitmentMs !== null
        ? { priorCommitment: this.gracePriorCommitment(this.lock.priorCommitmentMs, now) }
        : {}),
    };
  }

  /**
   * On a grace re-lock the promised window has already expired: SM.triggerAt is
   * the relock instant (when the promise ran out), so the user promised to stop
   * `promisedMs` before that. Elapsed-since-promise is therefore the full
   * promised window plus however long they've now been back past the re-lock.
   */
  private gracePriorCommitment(
    promisedMs: number,
    now: Date,
  ): { promisedMs: number; elapsedMs: number } {
    const sinceRelock = this.sm.triggerAt === undefined ? 0 : now.getTime() - this.sm.triggerAt;
    return { promisedMs, elapsedMs: promisedMs + Math.max(0, sinceRelock) };
  }

  private minutesLate(): number {
    if (this.sm.triggerAt === undefined) {
      return 0;
    }
    return Math.max(0, Math.round((this.nowMs() - this.sm.triggerAt) / 60_000));
  }

  private currentOverlayState(): OverlayState {
    const mode = this.overlayMode();
    const state: OverlayState = {
      mode,
      minutesLate: this.minutesLate(),
      strictness: this.settings.strictness,
      graceCapMin: this.settings.graceCapsMs[this.settings.strictness] / 60_000,
      overridePhrase: this.settings.overridePhrase,
      transcript: this.transcript,
    };
    if (this.lock.reentry === "grace") {
      state.reentry = { kind: "grace", ...this.graceReentryFields() };
    } else if (this.lock.reentry === "quickwake") {
      state.reentry = { kind: "quickwake", ...this.quickwakeReentryFields() };
    }
    return state;
  }

  /** `promisedMin`/`priorCommitmentAt` for a grace relock's overlay chip. */
  private graceReentryFields(): { promisedMin?: number; priorCommitmentAt?: string } {
    const promisedMs = this.lock.priorCommitmentMs;
    if (promisedMs === null) {
      return {};
    }
    const promisedMin = Math.round(promisedMs / 60_000);
    // The relock's triggerAt is (approximately) when the promised window ran
    // out, so the promise was made promisedMs earlier.
    const priorCommitmentAt =
      this.sm.triggerAt !== undefined
        ? new Date(this.sm.triggerAt - promisedMs).toISOString()
        : undefined;
    return { promisedMin, ...(priorCommitmentAt ? { priorCommitmentAt } : {}) };
  }

  /** `sleptAt`/`wakeTime`/`minutesSinceWake` for a quick-wake relock's overlay chip. */
  private quickwakeReentryFields(): {
    sleptAt?: string;
    wakeTime?: string;
    minutesSinceWake?: number;
  } {
    const sleptMs = this.lock.sleptMs;
    const wakeInstantMs = this.sm.triggerAt; // onWake sets triggerAt to the WAKE event's `now`.
    const sleptAt =
      sleptMs !== null && wakeInstantMs !== undefined
        ? new Date(wakeInstantMs - sleptMs).toISOString()
        : undefined;
    const minutesSinceWake = sleptMs !== null ? Math.round(sleptMs / 60_000) : undefined;
    return {
      ...(sleptAt ? { sleptAt } : {}),
      wakeTime: this.settings.wakeTime,
      ...(minutesSinceWake !== undefined ? { minutesSinceWake } : {}),
    };
  }

  private overlayMode(): OverlayState["mode"] {
    if (this.lock.reentry === "grace") {
      return "relock";
    }
    if (this.lock.reentry === "quickwake") {
      return "quickwake";
    }
    return this.transcript.length > 0 ? "mid" : "cold";
  }

  private pushCurrentState(): void {
    this.overlay.pushState(this.currentOverlayState());
  }

  // --- Persistence ---

  private persistSm(): void {
    this.store.write(SM_KEY, this.sm);
  }

  private persistTranscript(): void {
    this.store.write(TRANSCRIPT_KEY, this.transcript);
  }

  private clearTranscript(): void {
    this.transcript = [];
    this.persistTranscript();
  }
}

const GRANT_RE_GLOBAL = /<<GRANT:(\d+)>>/g;
const GRANT_RE_LINE = /<<GRANT:\d+>>/;

/**
 * Extracts the machine-readable grant marker from a gatekeeper reply and
 * returns the grant in minutes plus the reply with the marker line stripped.
 *
 * Fail-closed: any ambiguity — no marker, more than one marker, or a value
 * that isn't a clean non-negative integer — resolves to a 0-minute grant.
 * The parsed value is only ever a hint; the caller independently clamps it
 * through `capGrace`, so a value here can never itself exceed the cap.
 */
export function parseGrant(reply: string): { grantMinutes: number; cleanText: string } {
  const matches = [...reply.matchAll(GRANT_RE_GLOBAL)];
  const cleanText = stripGrantLines(reply);

  if (matches.length !== 1) {
    return { grantMinutes: 0, cleanText };
  }
  const parsed = Number.parseInt(matches[0][1], 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { grantMinutes: 0, cleanText };
  }
  return { grantMinutes: parsed, cleanText };
}

function stripGrantLines(reply: string): string {
  return reply
    .split("\n")
    .filter((line) => !GRANT_RE_LINE.test(line))
    .join("\n")
    .trim();
}
