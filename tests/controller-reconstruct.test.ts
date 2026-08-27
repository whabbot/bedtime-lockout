import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller, parseGrant } from "../src/main/controller";
import { Store } from "../src/main/store";
import { EventLog, type LockoutEvent } from "../src/main/eventlog";
import { DEFAULTS } from "../src/main/settings";
import type { SM } from "../src/main/statemachine";
import {
  FakeClock,
  FakePower,
  FakeLock,
  FakeNotifier,
  FakeGatekeeper,
  FakeOverlay,
  makeDeps,
  persistNoEscalationSettings,
} from "./helpers/fakes";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "btl-controller-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Controller startup reconstruction (#7)", () => {
  it("re-locks on startup when a persisted GRACE relockAt is already in the past", () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    const sm: SM = { phase: "GRACE", relockAt: now - 60_000, lastPromiseMs: 10 * 60_000 };
    store.write("sm", sm);

    const deps = makeDeps(now, dir);
    const overlay = deps.overlay as FakeOverlay;
    const controller = new Controller(deps);
    controller.start();
    controller.stop();

    // Reconstruction fired TICK → LOCKED + SHOW_OVERLAY(reentry: grace).
    const persisted = store.read<SM>("sm", { phase: "IDLE" });
    expect(persisted.phase).toBe("LOCKED");
    expect(overlay.shown).toBeGreaterThan(0);
    expect(overlay.last()?.mode).toBe("relock");
    expect(overlay.last()?.reentry?.kind).toBe("grace");
  });

  it("re-arms the relock timer (does not re-lock) when a persisted GRACE relockAt is still in the future", () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    const relockAt = now + 5 * 60_000;
    store.write("sm", { phase: "GRACE", relockAt, lastPromiseMs: 10 * 60_000 });

    const deps = makeDeps(now, dir);
    const overlay = deps.overlay as FakeOverlay;
    const controller = new Controller(deps);
    controller.start();

    // Still in GRACE, overlay not shown yet.
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("GRACE");
    expect(overlay.shown).toBe(0);

    // Advance the clock past relockAt and poke the timer: it should re-lock.
    (deps.clock as FakeClock).set(relockAt + 1);
    (controller as unknown as { timers: { checkNow(): void } }).timers.checkNow();
    controller.stop();

    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");
    expect(overlay.shown).toBeGreaterThan(0);
  });

  it("re-asserts the overlay on startup when persisted phase is LOCKED", () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "LOCKED", triggerAt: now - 30 * 60_000, escalated: false });

    const deps = makeDeps(now, dir);
    const overlay = deps.overlay as FakeOverlay;
    const controller = new Controller(deps);
    controller.start();
    controller.stop();

    expect(overlay.shown).toBe(1);
    expect(overlay.last()?.mode).toBe("cold");
    expect(overlay.last()?.minutesLate).toBe(30);
  });

  it("keeps the overlay hidden on startup for IDLE", () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "IDLE" });

    const deps = makeDeps(now, dir);
    const overlay = deps.overlay as FakeOverlay;
    const controller = new Controller(deps);
    controller.start();
    controller.stop();

    expect(overlay.shown).toBe(0);
    expect(overlay.hidden).toBeGreaterThan(0);
  });

  it("restores LOCKED escalated framing from persisted SM into the gatekeeper context", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "LOCKED", triggerAt: now, escalated: true });

    const deps = makeDeps(now, dir);
    const gk = deps.gatekeeper as FakeGatekeeper;
    gk.replies = ["No.\n<<GRANT:0>>"];
    const controller = new Controller(deps);
    controller.start();
    controller.stop();

    await controller.onSendMessage("please");
    expect(gk.calls[0].systemPrompt.toLowerCase()).toContain("escalation has triggered");
  });
});

describe("Controller.reloadSettings — live settings edit (Task 15)", () => {
  it("picks up a Store write made after construction, without a restart", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      overridePhrase: "let me finish tonight",
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const controller = new Controller(deps);
    controller.start();

    // The old phrase no longer matches once settings are edited underneath the
    // running Controller (as the settings IPC handler would do) and reloaded.
    store.write("settings", {
      ...DEFAULTS,
      overridePhrase: "new phrase",
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    controller.reloadSettings();

    const okOld = await controller.onSubmitOverride("let me finish tonight");
    expect(okOld).toBe(false);

    const okNew = await controller.onSubmitOverride("new phrase");
    expect(okNew).toBe(true);

    controller.stop();
  });
});

describe("Controller.triggerNow — manual lock (Task 15 tray)", () => {
  it("fires TRIGGER and shows the overlay when IDLE", () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "IDLE" });

    const deps = makeDeps(now, dir);
    const overlay = deps.overlay as FakeOverlay;
    const controller = new Controller(deps);
    controller.start();

    controller.triggerNow();
    controller.stop();

    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");
    expect(overlay.shown).toBeGreaterThan(0);
    expect(overlay.last()?.mode).toBe("cold");
  });

  it("is a no-op when already LOCKED (guarded by the same TRIGGER rule as the nightly timer)", () => {
    const now = 1_000_000;
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "LOCKED", triggerAt: now - 1000 });

    const deps = makeDeps(now, dir);
    const controller = new Controller(deps);
    controller.start();

    controller.triggerNow();
    controller.stop();

    const sm = store.read<SM>("sm", { phase: "IDLE" });
    expect(sm.phase).toBe("LOCKED");
    expect(sm.triggerAt).toBe(now - 1000); // unchanged — no-op, not re-triggered
  });
});

describe("parseGrant — fail-closed marker extraction", () => {
  it("parses a single well-formed grant and strips the marker line", () => {
    const { grantMinutes, cleanText } = parseGrant("Okay, ten minutes.\n<<GRANT:10>>");
    expect(grantMinutes).toBe(10);
    expect(cleanText).toBe("Okay, ten minutes.");
    expect(cleanText).not.toContain("GRANT");
  });

  it("treats a missing marker as a 0 grant (fail-closed)", () => {
    expect(parseGrant("Fine, whatever you want.").grantMinutes).toBe(0);
  });

  it("treats multiple markers as a 0 grant (fail-closed)", () => {
    const { grantMinutes, cleanText } = parseGrant("Hmm.\n<<GRANT:5>>\n<<GRANT:99>>");
    expect(grantMinutes).toBe(0);
    expect(cleanText).not.toContain("GRANT");
  });

  it("treats a malformed/non-numeric marker as a 0 grant (fail-closed)", () => {
    expect(parseGrant("No.\n<<GRANT:lots>>").grantMinutes).toBe(0);
    expect(parseGrant("No.\n<<GRANT:>>").grantMinutes).toBe(0);
  });

  it("strips the marker even on a 0 grant so the user never sees it", () => {
    expect(parseGrant("Not tonight.\n<<GRANT:0>>").cleanText).toBe("Not tonight.");
  });
});

describe("Controller onSendMessage — grant handling", () => {
  it("grants clamped grace via NEGOTIATED_UNLOCK and pushes a marker-free transcript", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      strictness: "Firm",
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const gk = deps.gatekeeper as FakeGatekeeper;
    gk.replies = ["Okay, ten minutes — that's it.\n<<GRANT:10>>"];
    const controller = new Controller(deps);
    controller.start();

    await controller.onSendMessage("I'm nearly done");
    controller.stop();

    const sm = store.read<SM>("sm", { phase: "IDLE" });
    expect(sm.phase).toBe("GRACE");
    // Firm cap is 15min, so a 10min grant survives intact.
    expect(sm.relockAt).toBe(now + 10 * 60_000);

    const transcript = store.read<{ role: string; text: string }[]>("transcript", []);
    const gkMsg = transcript.find((m) => m.role === "gatekeeper");
    expect(gkMsg?.text).not.toContain("GRANT");
    expect(gkMsg?.text).toContain("ten minutes");
  });

  it("clamps an over-cap grant down through capGrace (never trusts the model)", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      strictness: "Unmovable", // 5min cap
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const gk = deps.gatekeeper as FakeGatekeeper;
    gk.replies = ["Fine, an hour.\n<<GRANT:60>>"];
    const controller = new Controller(deps);
    controller.start();
    await controller.onSendMessage("give me an hour");
    controller.stop();

    const sm = store.read<SM>("sm", { phase: "IDLE" });
    expect(sm.phase).toBe("GRACE");
    expect(sm.relockAt).toBe(now + 5 * 60_000); // clamped to Unmovable cap
  });

  it("stays LOCKED on a 0-grant reply and appends the reply to the transcript", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const gk = deps.gatekeeper as FakeGatekeeper;
    gk.replies = ["Not good enough.\n<<GRANT:0>>"];
    const controller = new Controller(deps);
    controller.start();
    await controller.onSendMessage("just because");
    controller.stop();

    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");
    const transcript = store.read<{ role: string; text: string }[]>("transcript", []);
    expect(transcript.length).toBe(2);
  });

  it("fail-closes on GatekeeperUnreachable: logs the event, keeps LOCKED, signals the overlay", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const overlay = deps.overlay as FakeOverlay;
    const gk = deps.gatekeeper as FakeGatekeeper;
    gk.throwUnreachable = true;
    const controller = new Controller(deps);
    controller.start();

    const result = await controller.onSendMessage("please");
    controller.stop();

    expect(result).toEqual({ unreachable: true });
    expect(overlay.gatekeeperDown).toBe(1);
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");
    const events = store.read<LockoutEvent[]>("events", []);
    expect(events.some((e) => e.kind === "gatekeeper_unreachable")).toBe(true);
  });
});

describe("Controller onSubmitOverride — deterministic escape, never reaches the LLM", () => {
  it("fires OVERRIDE on an exact phrase match and logs a kind:override event", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      overridePhrase: "let me finish tonight",
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const gk = deps.gatekeeper as FakeGatekeeper;
    const controller = new Controller(deps);
    controller.start();

    const ok = await controller.onSubmitOverride("Let me finish tonight");
    controller.stop();

    expect(ok).toBe(true);
    expect(gk.calls.length).toBe(0); // never consulted the gatekeeper
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("OVERRIDE_NIGHT");
    const events = store.read<LockoutEvent[]>("events", []);
    expect(events.filter((e) => e.kind === "override").length).toBe(1);
  });

  it("returns false and changes nothing on a near-miss phrase", async () => {
    const now = 1_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      overridePhrase: "let me finish tonight",
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const controller = new Controller(deps);
    controller.start();

    const ok = await controller.onSubmitOverride("let me finish this");
    controller.stop();

    expect(ok).toBe(false);
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");
    expect(store.read<LockoutEvent[]>("events", []).length).toBe(0);
  });
});

describe("Controller — compressed full cycle", () => {
  it("runs trigger → negotiate → grace → relock → sleep → quickwake → override → new day", async () => {
    const t0 = 2_000_000_000;
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      strictness: "Gentle", // 45min cap so a 10min grant survives
      quickWakeWindowMs: 60 * 60_000,
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "IDLE" });

    const clock = new FakeClock(t0);
    const store2 = store;
    const deps = {
      clock,
      power: new FakePower(),
      lock: new FakeLock(),
      notifier: new FakeNotifier(),
      gatekeeper: new FakeGatekeeper(),
      store: store2,
      eventLog: new EventLog(store2),
      overlay: new FakeOverlay(),
    };
    const overlay = deps.overlay;
    const gk = deps.gatekeeper;
    const controller = new Controller(deps);
    controller.start();

    const dispatch = (controller as unknown as { dispatch(e: unknown): void }).dispatch.bind(
      controller,
    );

    // TRIGGER (scheduled bedtime).
    dispatch({ t: "TRIGGER", now: clock.now().getTime(), escalated: false });
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");

    // Negotiate a 10-minute grant.
    clock.advance(2 * 60_000);
    gk.replies = ["Ten minutes, no more.\n<<GRANT:10>>"];
    await controller.onSendMessage("almost done with this build");
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("GRACE");

    // Grace expires → relock via TICK.
    clock.advance(11 * 60_000);
    dispatch({ t: "TICK", now: clock.now().getTime() });
    let sm = store.read<SM>("sm", { phase: "IDLE" });
    expect(sm.phase).toBe("LOCKED");
    expect(overlay.last()?.mode).toBe("relock");

    // Sleep offered and accepted → SLEEP_WATCH, machine sleeps.
    controller.onRequestSleep();
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("SLEEP_WATCH");
    expect(deps.lock.locked).toBe(1);

    // Wake within the quick-wake window → LOCKED (quickwake), logged.
    clock.advance(5 * 60_000);
    dispatch({ t: "WAKE", now: clock.now().getTime() });
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("LOCKED");
    expect(overlay.last()?.mode).toBe("quickwake");
    let events = store.read<LockoutEvent[]>("events", []);
    expect(events.some((e) => e.kind === "quickwake")).toBe(true);

    // Override phrase → OVERRIDE_NIGHT.
    const ok = await controller.onSubmitOverride(DEFAULTS.overridePhrase);
    expect(ok).toBe(true);
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("OVERRIDE_NIGHT");
    events = store.read<LockoutEvent[]>("events", []);
    expect(events.some((e) => e.kind === "override")).toBe(true);

    // New day → IDLE, transcript cleared.
    dispatch({ t: "NEW_DAY", now: clock.now().getTime() });
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("IDLE");
    expect(store.read<unknown[]>("transcript", []).length).toBe(0);

    controller.stop();
  });
});

describe("Controller — day rollover re-arm (whole-branch review fix)", () => {
  it("dispatches NEW_DAY at wakeTime and re-arms the nightly trigger, even from OVERRIDE_NIGHT", () => {
    // 06:00 local — wakeTime defaults to "07:00", one hour ahead.
    const now = new Date(2026, 0, 1, 6, 0, 0).getTime();
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "OVERRIDE_NIGHT" });

    const deps = makeDeps(now, dir);
    const clock = deps.clock as FakeClock;
    const controller = new Controller(deps);
    controller.start();

    // Before wakeTime: still OVERRIDE_NIGHT, no in-app way back to IDLE.
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("OVERRIDE_NIGHT");

    // Advance past wakeTime and let the (fake) WallClockTimer fire.
    clock.set(new Date(2026, 0, 1, 7, 0, 1).getTime());
    const timers = (controller as unknown as { timers: { checkNow(): void } }).timers;
    timers.checkNow();
    controller.stop();

    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("IDLE");

    // The nightly trigger must have been re-armed for the next lockout —
    // this is the actual fix: without it, the app can never lock again.
    const pending = (
      controller as unknown as { timers: { pending(): { id: string; at: number }[] } }
    ).timers.pending();
    expect(pending.some((p) => p.id === "nightly-trigger")).toBe(true);

    // The day-rollover job itself must also have re-armed for the
    // following day — a naive self-rescheduling callback can get its fresh
    // registration wiped out by the timer's own post-fire cleanup (see
    // WallClockTimer's regression test in tests/timers.test.ts).
    expect(pending.some((p) => p.id === "day-rollover")).toBe(true);
  });

  it("recurs across two consecutive day boundaries, not just once", () => {
    const now = new Date(2026, 0, 1, 6, 0, 0).getTime();
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "OVERRIDE_NIGHT" });

    const deps = makeDeps(now, dir);
    const clock = deps.clock as FakeClock;
    const controller = new Controller(deps);
    controller.start();
    const timers = (
      controller as unknown as { timers: { checkNow(): void; pending(): { id: string }[] } }
    ).timers;

    // Day 1 rollover: OVERRIDE_NIGHT -> IDLE.
    clock.set(new Date(2026, 0, 1, 7, 0, 1).getTime());
    timers.checkNow();
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("IDLE");
    expect(timers.pending().some((p) => p.id === "day-rollover")).toBe(true);

    // Re-lock and override again, then confirm the SECOND day boundary
    // still fires and recovers it too.
    controller.triggerNow();
    void controller.onSubmitOverride(DEFAULTS.overridePhrase);
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("OVERRIDE_NIGHT");

    clock.set(new Date(2026, 0, 2, 7, 0, 1).getTime());
    timers.checkNow();
    controller.stop();

    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("IDLE");
  });

  it("re-arms the nightly trigger on a clean quick-wake-past-cutoff morning too", () => {
    const now = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "SLEEP_WATCH", quickWakeUntil: now + 60_000 });

    const deps = makeDeps(now, dir);
    const clock = deps.clock as FakeClock;
    const controller = new Controller(deps);
    controller.start();

    // Wake after the quick-wake cutoff → fresh morning, IDLE.
    clock.advance(2 * 60_000);
    const dispatch = (controller as unknown as { dispatch(e: unknown): void }).dispatch.bind(
      controller,
    );
    dispatch({ t: "WAKE", now: clock.now().getTime() });
    controller.stop();

    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("IDLE");
    const pending = (
      controller as unknown as { timers: { pending(): { id: string; at: number }[] } }
    ).timers.pending();
    expect(pending.some((p) => p.id === "nightly-trigger")).toBe(true);
  });
});

describe("Controller.onRequestSleep — relockPolicy wiring", () => {
  it("uses the next wakeTime occurrence as the quick-wake cutoff under the default 'wakeTime' policy", () => {
    const now = new Date(2026, 0, 1, 23, 47, 0).getTime(); // 11:47 PM, wakeTime "07:00" next day
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const controller = new Controller(deps);
    controller.start();
    controller.onRequestSleep();
    controller.stop();

    const sm = store.read<SM>("sm", { phase: "IDLE" });
    expect(sm.phase).toBe("SLEEP_WATCH");
    expect(sm.quickWakeUntil).toBe(new Date(2026, 0, 2, 7, 0, 0).getTime());
  });

  it("falls back to the relative quickWakeWindowMs under the 'window' policy", () => {
    const now = new Date(2026, 0, 1, 23, 47, 0).getTime();
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      relockPolicy: "window",
      quickWakeWindowMs: 60 * 60_000,
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "LOCKED", triggerAt: now });

    const deps = makeDeps(now, dir);
    const controller = new Controller(deps);
    controller.start();
    controller.onRequestSleep();
    controller.stop();

    const sm = store.read<SM>("sm", { phase: "IDLE" });
    expect(sm.quickWakeUntil).toBe(now + 60 * 60_000);
  });
});

describe("Controller overlay reentry payload — full chip data (whole-branch review fix)", () => {
  it("populates promisedMin and priorCommitmentAt on a grace relock", async () => {
    const t0 = new Date(2026, 0, 1, 23, 0, 0).getTime();
    const store = new Store(dir);
    store.write("settings", {
      ...DEFAULTS,
      strictness: "Gentle", // 45min cap, so a 10min grant survives
      escalation: { ...DEFAULTS.escalation, enabled: false },
    });
    store.write("sm", { phase: "IDLE" });

    const clock = new FakeClock(t0);
    const deps = { ...makeDeps(t0, dir), clock };
    const overlay = deps.overlay as FakeOverlay;
    const gk = deps.gatekeeper as FakeGatekeeper;
    const controller = new Controller(deps);
    controller.start();

    controller.triggerNow();
    gk.replies = ["Ten minutes.\n<<GRANT:10>>"];
    await controller.onSendMessage("almost done");
    expect(store.read<SM>("sm", { phase: "IDLE" }).phase).toBe("GRACE");

    clock.advance(11 * 60_000); // grace (10 min) elapses
    const dispatch = (controller as unknown as { dispatch(e: unknown): void }).dispatch.bind(
      controller,
    );
    dispatch({ t: "TICK", now: clock.now().getTime() });
    controller.stop();

    const relock = overlay.last();
    expect(relock?.mode).toBe("relock");
    expect(relock?.reentry?.kind).toBe("grace");
    expect(relock?.reentry?.promisedMin).toBe(10);
    expect(relock?.reentry?.priorCommitmentAt).toBeTruthy();
  });

  it("populates sleptAt, wakeTime, and minutesSinceWake on a quick-wake relock", () => {
    const t0 = new Date(2026, 0, 1, 0, 20, 0).getTime(); // 12:20 AM
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    store.write("sm", { phase: "LOCKED", triggerAt: t0 });

    const clock = new FakeClock(t0);
    const deps = { ...makeDeps(t0, dir), clock };
    const overlay = deps.overlay as FakeOverlay;
    const controller = new Controller(deps);
    controller.start();
    controller.onRequestSleep(); // -> SLEEP_WATCH, sleepStartedAt = t0

    clock.advance(18 * 60_000); // wake 18 minutes later, well within the window
    const dispatch = (controller as unknown as { dispatch(e: unknown): void }).dispatch.bind(
      controller,
    );
    dispatch({ t: "WAKE", now: clock.now().getTime() });
    controller.stop();

    const quickwake = overlay.last();
    expect(quickwake?.mode).toBe("quickwake");
    expect(quickwake?.reentry?.kind).toBe("quickwake");
    expect(quickwake?.reentry?.sleptAt).toBe(new Date(t0).toISOString());
    expect(quickwake?.reentry?.wakeTime).toBe(DEFAULTS.wakeTime);
    expect(quickwake?.reentry?.minutesSinceWake).toBe(18);
  });
});
