import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { WallClockTimer } from "../src/main/timers";
import type { ClockPort } from "../src/main/ports";

function fakeClock(startMs: number): ClockPort & { set(ms: number): void } {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    set: (next: number) => {
      ms = next;
    },
  };
}

const MINUTE_MS = 60_000;

describe("WallClockTimer", () => {
  it("fires a callback once the clock passes its target, and not again after", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);
    const callback = vi.fn();

    timer.schedule("foo", 10 * MINUTE_MS, callback);

    clock.set(5 * MINUTE_MS);
    timer.checkNow();
    expect(callback).not.toHaveBeenCalled();

    clock.set(11 * MINUTE_MS);
    timer.checkNow();
    expect(callback).toHaveBeenCalledTimes(1);

    timer.checkNow();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires independently-scheduled targets independently", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);
    const early = vi.fn();
    const late = vi.fn();

    timer.schedule("early", 5 * MINUTE_MS, early);
    timer.schedule("late", 15 * MINUTE_MS, late);

    clock.set(10 * MINUTE_MS);
    timer.checkNow();
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();

    clock.set(20 * MINUTE_MS);
    timer.checkNow();
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("persists scheduled targets and reconstructs them as pending on a fresh instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);

    timer.schedule("foo", 10 * MINUTE_MS, vi.fn());

    const restarted = new WallClockTimer(new Store(dir), clock);
    expect(restarted.pending()).toEqual([{ id: "foo", at: 10 * MINUTE_MS }]);
  });

  it("does not silently fire a reconstructed target that has no callback re-attached", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);
    timer.schedule("foo", 10 * MINUTE_MS, vi.fn());

    const restarted = new WallClockTimer(new Store(dir), clock);
    clock.set(11 * MINUTE_MS);
    restarted.checkNow();

    expect(restarted.pending()).toEqual([{ id: "foo", at: 10 * MINUTE_MS }]);

    const callback = vi.fn();
    restarted.schedule("foo", 10 * MINUTE_MS, callback);
    restarted.checkNow();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("re-scheduling an existing id updates the target without duplicating the persisted entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);

    timer.schedule("foo", 10 * MINUTE_MS, vi.fn());
    const callback = vi.fn();
    timer.schedule("foo", 20 * MINUTE_MS, callback);

    expect(timer.pending()).toEqual([{ id: "foo", at: 20 * MINUTE_MS }]);

    clock.set(25 * MINUTE_MS);
    timer.checkNow();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("removes a fired target from the persisted store, not just from memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);

    timer.schedule("foo", 10 * MINUTE_MS, vi.fn());
    clock.set(11 * MINUTE_MS);
    timer.checkNow();

    const another = new WallClockTimer(new Store(dir), clock);
    expect(another.pending()).toEqual([]);
  });

  it("survives a callback that re-schedules its own id before returning (recurring jobs)", () => {
    // A callback calling schedule() on the same id it's currently firing for
    // (to make itself a recurring job) must not have that fresh
    // re-registration wiped out by checkNow()'s post-callback cleanup.
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);
    let fireCount = 0;

    function recurring(): void {
      fireCount += 1;
      timer.schedule("daily", clock.now().getTime() + 10 * MINUTE_MS, recurring);
    }
    timer.schedule("daily", 10 * MINUTE_MS, recurring);

    clock.set(11 * MINUTE_MS);
    timer.checkNow();
    expect(fireCount).toBe(1);
    expect(timer.pending()).toEqual([{ id: "daily", at: 21 * MINUTE_MS }]);

    // It must fire AGAIN next cycle — this is what a naive unconditional
    // delete-by-id would break (the re-registration above would have been
    // silently deleted, so this second checkNow() would never fire).
    clock.set(22 * MINUTE_MS);
    timer.checkNow();
    expect(fireCount).toBe(2);
    expect(timer.pending()).toEqual([{ id: "daily", at: 32 * MINUTE_MS }]);
  });

  it("does not fire a due target whose snapshot was superseded by an earlier callback in the same batch", () => {
    // Two targets are due in the same checkNow() call. Processing the first
    // (in insertion order) re-arms the second to a future time — the second
    // must NOT still fire using its now-stale snapshot.
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);
    const secondFired = vi.fn();

    timer.schedule("first", 10 * MINUTE_MS, () => {
      // Re-arm "second" far in the future — it must not fire in this batch.
      timer.schedule("second", clock.now().getTime() + 60 * MINUTE_MS, secondFired);
    });
    timer.schedule("second", 10 * MINUTE_MS, secondFired);

    clock.set(11 * MINUTE_MS);
    timer.checkNow();

    expect(secondFired).not.toHaveBeenCalled();
    expect(timer.pending()).toEqual([{ id: "second", at: 71 * MINUTE_MS }]);
  });

  it("still removes a non-recurring target normally when a callback fires and does nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const clock = fakeClock(0);
    const timer = new WallClockTimer(new Store(dir), clock);
    const callback = vi.fn();

    timer.schedule("foo", 10 * MINUTE_MS, callback);
    clock.set(11 * MINUTE_MS);
    timer.checkNow();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(timer.pending()).toEqual([]);
  });
});
