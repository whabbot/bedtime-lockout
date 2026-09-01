import { describe, it, expect } from "vitest";
import { reduce, type SM } from "../src/main/statemachine";

function locked(triggerAt: number): SM {
  return { phase: "LOCKED", triggerAt };
}

describe("statemachine — brief semantics", () => {
  it("TRIGGER moves IDLE to LOCKED and shows the overlay", () => {
    const { state, effects } = reduce({ phase: "IDLE" }, { t: "TRIGGER", now: 0 });
    expect(state.phase).toBe("LOCKED");
    expect(state.triggerAt).toBe(0);
    expect(effects.find((e) => e.type === "SHOW_OVERLAY")).toBeTruthy();
  });

  it("NEGOTIATED_UNLOCK from LOCKED moves to GRACE with relockAt and lastPromiseMs, hides overlay", () => {
    const { state, effects } = reduce(locked(0), {
      t: "NEGOTIATED_UNLOCK",
      now: 0,
      graceMs: 10 * 60000,
    });
    expect(state.phase).toBe("GRACE");
    expect(state.relockAt).toBe(10 * 60000);
    expect(state.lastPromiseMs).toBe(10 * 60000);
    expect(effects.find((e) => e.type === "HIDE_OVERLAY")).toBeTruthy();
  });

  it("NEGOTIATED_UNLOCK arms a relock timer for the Controller at relockAt", () => {
    const { effects } = reduce(locked(0), {
      t: "NEGOTIATED_UNLOCK",
      now: 0,
      graceMs: 10 * 60000,
    });
    const arm = effects.find((e) => e.type === "ARM_RELOCK");
    expect(arm?.payload?.at).toBe(10 * 60000);
  });

  const SLEEP_AT_MIDNIGHT = { t: "SLEEP" as const, now: 0, quickWakeUntil: 8 * 3600000 }; // cutoff = 8 AM

  it("quick-wake re-locks even on a near-instant sleep/wake", () => {
    const { state } = reduce(locked(0), SLEEP_AT_MIDNIGHT);
    const r = reduce(state, { t: "WAKE", now: 2000 }); // woke after 2 SECONDS, before cutoff
    expect(r.state.phase).toBe("LOCKED");
    expect(r.effects.find((e) => e.type === "SHOW_OVERLAY")?.reentry).toBe("quickwake");
  });

  it("wake at/after the cutoff is a clean fresh start, no re-lock", () => {
    const { state } = reduce(locked(0), SLEEP_AT_MIDNIGHT);
    expect(reduce(state, { t: "WAKE", now: 9 * 3600000 }).state.phase).toBe("IDLE"); // 9 AM > 8 AM cutoff
  });

  it("grace re-arms and re-locks with prior commitment when it elapses", () => {
    const { state } = reduce(locked(0), { t: "NEGOTIATED_UNLOCK", now: 0, graceMs: 10 * 60000 });
    expect(state.phase).toBe("GRACE");
    const r = reduce(state, { t: "TICK", now: 10 * 60000 + 1 });
    expect(r.state.phase).toBe("LOCKED");
    expect(r.effects.find((e) => e.type === "SHOW_OVERLAY")?.reentry).toBe("grace");
  });

  it("override suppresses re-lock for the rest of the night", () => {
    const { state } = reduce(locked(0), { t: "OVERRIDE", now: 0 });
    expect(state.phase).toBe("OVERRIDE_NIGHT");
    expect(reduce(state, { t: "TICK", now: 5 * 60 * 60000 }).state.phase).toBe("OVERRIDE_NIGHT"); // still no relock
    expect(reduce(state, { t: "NEW_DAY", now: 8 * 60 * 60000 }).state.phase).toBe("IDLE");
  });
});

describe("statemachine — TICK in GRACE before relockAt", () => {
  it("stays in GRACE and emits no effects when relockAt has not yet elapsed", () => {
    const { state } = reduce(locked(0), { t: "NEGOTIATED_UNLOCK", now: 0, graceMs: 10 * 60000 });
    const r = reduce(state, { t: "TICK", now: 5 * 60000 });
    expect(r.state.phase).toBe("GRACE");
    expect(r.effects).toEqual([]);
  });
});

describe("statemachine — OVERRIDE emits a LOG effect a Controller can build kind:'override' from", () => {
  it("LOG effect payload identifies itself as an override", () => {
    const { effects } = reduce(locked(0), { t: "OVERRIDE", now: 123 });
    const log = effects.find((e) => e.type === "LOG");
    expect(log).toBeTruthy();
    expect(log?.payload?.kind).toBe("override");
  });
});

describe("statemachine — quick-wake LOG effect carries enough to build kind:'quickwake'", () => {
  it("LOG effect payload identifies itself as a quickwake and carries sleptMs", () => {
    const { state } = reduce(locked(0), {
      t: "SLEEP",
      now: 1000,
      quickWakeUntil: 8 * 3600000,
    });
    const r = reduce(state, { t: "WAKE", now: 1000 + 2000 });
    const log = r.effects.find((e) => e.type === "LOG");
    expect(log).toBeTruthy();
    expect(log?.payload?.kind).toBe("quickwake");
    expect(log?.payload?.sleptMs).toBe(2000);
  });
});

describe("statemachine — a fresh TRIGGER-driven lock", () => {
  it("a fresh TRIGGER-driven lock has no reentry on its SHOW_OVERLAY effect", () => {
    const { effects } = reduce({ phase: "IDLE" }, { t: "TRIGGER", now: 0 });
    const overlay = effects.find((e) => e.type === "SHOW_OVERLAY");
    expect(overlay?.reentry).toBeUndefined();
  });
});

describe("statemachine — SLEEP from GRACE (not just LOCKED)", () => {
  it("SLEEP transitions GRACE to SLEEP_WATCH with LOCK_NOW and HIDE_OVERLAY", () => {
    const { state } = reduce(locked(0), { t: "NEGOTIATED_UNLOCK", now: 0, graceMs: 10 * 60000 });
    const r = reduce(state, { t: "SLEEP", now: 60000, quickWakeUntil: 8 * 3600000 });
    expect(r.state.phase).toBe("SLEEP_WATCH");
    expect(r.effects.find((e) => e.type === "LOCK_NOW")).toBeTruthy();
    expect(r.effects.find((e) => e.type === "HIDE_OVERLAY")).toBeTruthy();
  });
});

describe("statemachine — stale field cleanup across transitions", () => {
  it("moving LOCKED -> OVERRIDE_NIGHT does not carry over triggerAt", () => {
    const { state } = reduce(locked(123), { t: "OVERRIDE", now: 200 });
    expect(state.triggerAt).toBeUndefined();
  });

  it("moving GRACE -> LOCKED (re-arm) does not carry over relockAt/lastPromiseMs", () => {
    const { state } = reduce(locked(0), { t: "NEGOTIATED_UNLOCK", now: 0, graceMs: 60000 });
    const r = reduce(state, { t: "TICK", now: 60001 });
    expect(r.state.relockAt).toBeUndefined();
    expect(r.state.lastPromiseMs).toBeUndefined();
  });

  it("moving SLEEP_WATCH -> IDLE (fresh morning) carries over no stale fields at all", () => {
    const { state } = reduce(locked(0), { t: "SLEEP", now: 0, quickWakeUntil: 8 * 3600000 });
    const r = reduce(state, { t: "WAKE", now: 9 * 3600000 });
    expect(r.state).toEqual({ phase: "IDLE" });
  });

  it("NEW_DAY back to IDLE clears all optional fields", () => {
    const { state } = reduce(locked(0), { t: "OVERRIDE", now: 0 });
    const r = reduce(state, { t: "NEW_DAY", now: 500 });
    expect(r.state).toEqual({ phase: "IDLE" });
  });
});

describe("statemachine — invalid/out-of-phase events are no-ops", () => {
  it("NEGOTIATED_UNLOCK while IDLE is a no-op", () => {
    const s: SM = { phase: "IDLE" };
    const r = reduce(s, { t: "NEGOTIATED_UNLOCK", now: 0, graceMs: 60000 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it("WAKE while not in SLEEP_WATCH is a no-op", () => {
    const s = locked(0);
    const r = reduce(s, { t: "WAKE", now: 0 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it("OVERRIDE while IDLE is a no-op", () => {
    const s: SM = { phase: "IDLE" };
    const r = reduce(s, { t: "OVERRIDE", now: 0 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it("a stale/replayed TRIGGER cannot re-lock a night already in OVERRIDE_NIGHT", () => {
    const { state } = reduce(locked(0), { t: "OVERRIDE", now: 0 });
    const r = reduce(state, { t: "TRIGGER", now: 1000 });
    expect(r.state).toEqual(state);
    expect(r.effects).toEqual([]);
  });

  it("a force:true TRIGGER (manual 'Lock now') re-locks even from OVERRIDE_NIGHT", () => {
    const { state } = reduce(locked(0), { t: "OVERRIDE", now: 0 });
    const r = reduce(state, { t: "TRIGGER", now: 1000, force: true });
    expect(r.state.phase).toBe("LOCKED");
    expect(r.effects.some((e) => e.type === "SHOW_OVERLAY")).toBe(true);
  });

  it("a stale/replayed TRIGGER while already LOCKED is a no-op", () => {
    const s = locked(0);
    const r = reduce(s, { t: "TRIGGER", now: 1000 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it("a stale/replayed TRIGGER while in GRACE or SLEEP_WATCH is a no-op", () => {
    const { state: graceState } = reduce(locked(0), {
      t: "NEGOTIATED_UNLOCK",
      now: 0,
      graceMs: 60000,
    });
    const graceResult = reduce(graceState, { t: "TRIGGER", now: 1000 });
    expect(graceResult.state).toEqual(graceState);
    expect(graceResult.effects).toEqual([]);

    const { state: sleepState } = reduce(locked(0), {
      t: "SLEEP",
      now: 0,
      quickWakeUntil: 1000,
    });
    const sleepResult = reduce(sleepState, { t: "TRIGGER", now: 500 });
    expect(sleepResult.state).toEqual(sleepState);
    expect(sleepResult.effects).toEqual([]);
  });

  it("TRIGGER from COUNTDOWN behaves like TRIGGER from IDLE", () => {
    const r = reduce({ phase: "COUNTDOWN" }, { t: "TRIGGER", now: 0 });
    expect(r.state.phase).toBe("LOCKED");
    expect(r.effects.find((e) => e.type === "SHOW_OVERLAY")).toBeTruthy();
  });

  it("SLEEP while IDLE is a no-op", () => {
    const s: SM = { phase: "IDLE" };
    const r = reduce(s, { t: "SLEEP", now: 0, quickWakeUntil: 1000 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });

  it("an event received during COUNTDOWN does not crash and is a no-op", () => {
    const s: SM = { phase: "COUNTDOWN" };
    const r = reduce(s, { t: "OVERRIDE", now: 0 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
});

describe("statemachine — TICK is a no-op outside GRACE", () => {
  it("TICK in IDLE, LOCKED, OVERRIDE_NIGHT, and SLEEP_WATCH changes nothing", () => {
    const idle: SM = { phase: "IDLE" };
    expect(reduce(idle, { t: "TICK", now: 1 })).toEqual({ state: idle, effects: [] });

    const lockedState = locked(0);
    expect(reduce(lockedState, { t: "TICK", now: 1 })).toEqual({
      state: lockedState,
      effects: [],
    });

    const { state: overrideState } = reduce(locked(0), { t: "OVERRIDE", now: 0 });
    expect(reduce(overrideState, { t: "TICK", now: 1 })).toEqual({
      state: overrideState,
      effects: [],
    });

    const { state: sleepState } = reduce(locked(0), {
      t: "SLEEP",
      now: 0,
      quickWakeUntil: 1000,
    });
    expect(reduce(sleepState, { t: "TICK", now: 1 })).toEqual({ state: sleepState, effects: [] });
  });
});
