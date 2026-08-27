/**
 * Post-unlock state machine: governs every phase transition of a bedtime
 * lockout night. PURE — no Date.now(), no I/O, no Electron, no Store/EventLog
 * calls. `now` is provided on every event; `SM` is plain serializable data so
 * it can be persisted and safely reloaded after an app restart or crash.
 *
 * `reduce()` decides; a separate Controller interprets the returned
 * `Effect[]` against real Store/EventLog/overlay/OS ports. `COUNTDOWN` is
 * reserved for that Controller to set directly (e.g. while scheduling
 * countdown notifications) — no event in this module transitions into or
 * out of it.
 */

export type Phase = "IDLE" | "COUNTDOWN" | "LOCKED" | "GRACE" | "OVERRIDE_NIGHT" | "SLEEP_WATCH";

export interface SM {
  phase: Phase;
  triggerAt?: number;
  relockAt?: number;
  quickWakeUntil?: number;
  lastPromiseMs?: number;
  /**
   * Wall-clock epoch ms at which SLEEP_WATCH began. Needed to compute
   * `sleptMs` for the quick-wake LOG effect on WAKE — `quickWakeUntil` alone
   * can't recover this under the `relockPolicy==='wakeTime'` policy, since
   * then it's an absolute cutoff unrelated to when sleep started.
   */
  sleepStartedAt?: number;
  /**
   * Whether the current lock was triggered by continuous-activity escalation
   * rather than the scheduled bedtime. Persisted so a crash between TRIGGER
   * and the first gatekeeper turn doesn't lose the escalation framing the
   * gatekeeper prompt needs; the Controller reads it back when assembling
   * GatekeeperContext.escalated.
   */
  escalated?: boolean;
}

export type Event =
  | { t: "TICK"; now: number }
  | { t: "TRIGGER"; now: number; escalated: boolean; force?: boolean }
  | { t: "NEGOTIATED_UNLOCK"; now: number; graceMs: number }
  | { t: "OVERRIDE"; now: number }
  | { t: "SLEEP"; now: number; quickWakeUntil: number }
  | { t: "WAKE"; now: number }
  | { t: "NEW_DAY"; now: number };

export interface Effect {
  type: "SHOW_OVERLAY" | "HIDE_OVERLAY" | "LOCK_NOW" | "ARM_RELOCK" | "LOG";
  payload?: any;
  reentry?: "grace" | "quickwake";
}

function showOverlay(opts: {
  reentry?: "grace" | "quickwake";
  escalated?: boolean;
  priorCommitmentMs?: number;
}): Effect {
  const effect: Effect = {
    type: "SHOW_OVERLAY",
    payload: {
      escalated: opts.escalated ?? false,
      ...(opts.priorCommitmentMs !== undefined
        ? { priorCommitmentMs: opts.priorCommitmentMs }
        : {}),
    },
  };
  if (opts.reentry) {
    effect.reentry = opts.reentry;
  }
  return effect;
}

const HIDE_OVERLAY: Effect = { type: "HIDE_OVERLAY" };

function noop(state: SM): { state: SM; effects: Effect[] } {
  return { state, effects: [] };
}

function onTrigger(now: number, escalated: boolean): { state: SM; effects: Effect[] } {
  return {
    state: { phase: "LOCKED", triggerAt: now, escalated },
    effects: [showOverlay({ escalated })],
  };
}

function onNegotiatedUnlock(now: number, graceMs: number): { state: SM; effects: Effect[] } {
  const relockAt = now + graceMs;
  return {
    state: { phase: "GRACE", relockAt, lastPromiseMs: graceMs },
    // ARM_RELOCK tells the Controller to schedule a real timer for relockAt —
    // GRACE is the only phase whose re-lock is timer-driven rather than
    // event-driven (SLEEP_WATCH's re-lock instead reacts to a WAKE event).
    effects: [HIDE_OVERLAY, { type: "ARM_RELOCK", payload: { at: relockAt } }],
  };
}

function onTickInGrace(state: SM, now: number): { state: SM; effects: Effect[] } {
  if (state.relockAt === undefined || now < state.relockAt) {
    return noop(state);
  }
  return {
    state: { phase: "LOCKED", triggerAt: now },
    effects: [showOverlay({ reentry: "grace", priorCommitmentMs: state.lastPromiseMs })],
  };
}

function onOverride(now: number): { state: SM; effects: Effect[] } {
  return {
    state: { phase: "OVERRIDE_NIGHT" },
    effects: [
      HIDE_OVERLAY,
      // Task 3's EventLog.summaryForGatekeeper counts overrides by
      // `kind === 'override'`, not `kind: 'unlock', method: 'override'` — the
      // Controller builds that event straight from this payload's `kind`.
      { type: "LOG", payload: { kind: "override", at: now } },
    ],
  };
}

function onSleep(state: SM, now: number, quickWakeUntil: number): { state: SM; effects: Effect[] } {
  if (state.phase !== "LOCKED" && state.phase !== "GRACE") {
    return noop(state);
  }
  return {
    state: { phase: "SLEEP_WATCH", quickWakeUntil, sleepStartedAt: now },
    effects: [{ type: "LOCK_NOW" }, HIDE_OVERLAY],
  };
}

function onWake(state: SM, now: number): { state: SM; effects: Effect[] } {
  if (state.phase !== "SLEEP_WATCH" || state.quickWakeUntil === undefined) {
    return noop(state);
  }
  if (now <= state.quickWakeUntil) {
    const sleptMs = state.sleepStartedAt === undefined ? 0 : now - state.sleepStartedAt;
    return {
      state: { phase: "LOCKED", triggerAt: now },
      effects: [
        showOverlay({ reentry: "quickwake" }),
        { type: "LOG", payload: { kind: "quickwake", at: now, sleptMs } },
      ],
    };
  }
  return { state: { phase: "IDLE" }, effects: [] };
}

/**
 * Decides the next `SM` and the `Effect`s a later Controller should perform,
 * given the current state and one event. Events that don't apply to the
 * current phase (e.g. a replayed/duplicate event after a crash restart) are
 * no-ops: same state returned unchanged, no effects — the safest default for
 * a persisted state machine that may see events out of order.
 */
export function reduce(s: SM, e: Event): { state: SM; effects: Effect[] } {
  switch (e.t) {
    case "TRIGGER":
      // Already locked: always a no-op, force or not — re-triggering would
      // reset triggerAt/escalated for no benefit, since the lock this would
      // produce is indistinguishable from the one already showing.
      if (s.phase === "LOCKED") {
        return noop(s);
      }
      // Otherwise guarded to IDLE/COUNTDOWN so a stale/replayed TRIGGER (e.g.
      // after a crash restart) can never re-lock a night already past its one
      // legitimate trigger — this is what keeps OVERRIDE_NIGHT's "no re-lock
      // until NEW_DAY" guarantee intact against duplicate events. `force`
      // bypasses this for the tray's manual "Lock now": that's a deliberate,
      // one-off user action rather than a replayed/duplicate scheduled event,
      // so it isn't subject to the same guarantee an override phrase makes
      // about the automatic nightly/escalation trigger.
      if (!e.force && s.phase !== "IDLE" && s.phase !== "COUNTDOWN") {
        return noop(s);
      }
      return onTrigger(e.now, e.escalated);

    case "NEGOTIATED_UNLOCK":
      if (s.phase !== "LOCKED") {
        return noop(s);
      }
      return onNegotiatedUnlock(e.now, e.graceMs);

    case "TICK":
      if (s.phase !== "GRACE") {
        return noop(s);
      }
      return onTickInGrace(s, e.now);

    case "OVERRIDE":
      if (s.phase !== "LOCKED") {
        return noop(s);
      }
      return onOverride(e.now);

    case "SLEEP":
      return onSleep(s, e.now, e.quickWakeUntil);

    case "WAKE":
      return onWake(s, e.now);

    case "NEW_DAY":
      return { state: { phase: "IDLE" }, effects: [] };
  }
}
