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
