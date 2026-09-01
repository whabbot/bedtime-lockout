import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduce, type SM } from "../src/main/statemachine";
import { Controller } from "../src/main/controller";
import { Store } from "../src/main/store";
import { makeDeps, persistDefaultSettings, FakeOverlay, FakeLock } from "./helpers/fakes";

const HOUR = 3_600_000;
const locked = (triggerAt: number): SM => ({ phase: "LOCKED", triggerAt });

describe("scenarios — quickwake boundary is inclusive at exactly quickWakeUntil", () => {
  const CUTOFF = 8 * HOUR;
  const sleep = { t: "SLEEP" as const, now: 0, quickWakeUntil: CUTOFF };

  it("wake at exactly quickWakeUntil re-locks (boundary is now <= quickWakeUntil)", () => {
    const { state } = reduce(locked(0), sleep);
    const r = reduce(state, { t: "WAKE", now: CUTOFF });
    expect(r.state.phase).toBe("LOCKED");
    expect(r.effects.find((e) => e.type === "SHOW_OVERLAY")?.reentry).toBe("quickwake");
  });

  it("wake one ms past quickWakeUntil is a clean fresh start", () => {
    const { state } = reduce(locked(0), sleep);
    expect(reduce(state, { t: "WAKE", now: CUTOFF + 1 }).state.phase).toBe("IDLE");
  });
});

describe("scenarios — reconstructing OVERRIDE_NIGHT does not re-cage or re-lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "btl-scenarios-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots into OVERRIDE_NIGHT with no overlay shown and no lock", () => {
    const store = new Store(dir);
    persistDefaultSettings(store);
    const sm: SM = { phase: "OVERRIDE_NIGHT" };
    store.write("sm", sm);

    const deps = makeDeps(1_000_000, dir);
    const controller = new Controller(deps);
    controller.start();

    const overlay = deps.overlay as FakeOverlay;
    expect(overlay.shown).toBe(0);
    expect((deps.lock as FakeLock).locked).toBe(0);
    expect(controller.snapshot().phase).toBe("OVERRIDE_NIGHT");

    controller.stop();
  });
});

describe("scenarios — resetting the snooze re-runs the schedule from now", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "btl-reset-snooze-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function bootSnoozed(nowMs: number): {
    controller: Controller;
    overlay: FakeOverlay;
    store: Store;
  } {
    const store = new Store(dir);
    persistDefaultSettings(store);
    store.write("sm", { phase: "OVERRIDE_NIGHT" } satisfies SM);

    const deps = makeDeps(nowMs, dir);
    const controller = new Controller(deps);
    controller.start();
    return { controller, overlay: deps.overlay as FakeOverlay, store };
  }

  // Defaults: lockout 23:30, wake 07:00.
  const at = (h: number, m: number): number => new Date(2026, 5, 29, h, m, 0).getTime();

  it("reports the wake time as the snooze end while snoozed, and nothing once reset", () => {
    const { controller } = bootSnoozed(at(22, 0));

    expect(controller.snoozedUntilMs()).toBe(at(7, 0) + 24 * HOUR);
    controller.resetSnooze();
    expect(controller.snoozedUntilMs()).toBeNull();
    controller.stop();
  });

  it("is a no-op when nothing is snoozed, leaving a live lock alone", () => {
    const { controller, overlay } = bootSnoozed(at(23, 45));
    controller.triggerNow();
    const shown = overlay.shown;
    const hidden = overlay.hidden;

    controller.resetSnooze();

    expect(controller.snapshot().phase).toBe("LOCKED");
    expect(overlay.shown).toBe(shown);
    expect(overlay.hidden).toBe(hidden);
    controller.stop();
  });

  it("locks straight away when now is already inside the lockout window", () => {
    const { controller, overlay } = bootSnoozed(at(23, 45));

    controller.resetSnooze();

    expect(controller.snapshot().phase).toBe("LOCKED");
    expect(overlay.shown).toBeGreaterThan(0);
    controller.stop();
  });

  it("goes back to armed-and-idle when now is before tonight's lockout time", () => {
    const { controller, overlay, store } = bootSnoozed(at(22, 0));

    controller.resetSnooze();

    expect(controller.snapshot().phase).toBe("IDLE");
    expect(overlay.shown).toBe(0);
    // OVERRIDE_NIGHT leaves the nightly trigger unscheduled; the reset must
    // re-arm tonight's lock rather than just clearing the phase.
    const timers = store.read<{ id: string; at: number }[]>("timers", []);
    expect(timers.find((t) => t.id === "nightly-trigger")?.at).toBe(at(23, 30));
    controller.stop();
  });
});
