import { describe, it, expect } from "vitest";
import { nextTrigger, countdownFirings, recompress } from "../src/main/scheduler";

const at = (h: number, m: number, d = 29) => new Date(2026, 5, d, h, m, 0);

describe("scheduler", () => {
  it("nextTrigger picks today if time is still ahead", () => {
    expect(nextTrigger("23:00", at(22, 0))).toEqual(at(23, 0));
  });

  it("nextTrigger rolls to tomorrow if time already passed", () => {
    expect(nextTrigger("23:00", at(23, 30))).toEqual(at(23, 0, 30));
  });

  it("countdownFirings returns only future leads, sorted ascending", () => {
    const f = countdownFirings(at(23, 0), [60, 15, 5], at(22, 50));
    expect(f).toEqual([at(22, 55)]); // 60 & 15 already passed at 22:50
  });

  it("recompress collapses now-or-past leads to a single immediate firing", () => {
    // escalation pulls trigger to 22:52 while it is already 22:50; leads 60/15/5
    const f = recompress(at(22, 52), [60, 15, 5], at(22, 50));
    expect(f.every((t) => t.getTime() >= at(22, 50).getTime())).toBe(true);
    expect(f.length).toBe(1); // only the 5-min-ish window survives, collapsed
    expect(f[0].getTime()).toBeLessThanOrEqual(at(22, 52).getTime());
  });

  it("recompress with trigger in <1s schedules immediate, never negative", () => {
    const f = recompress(at(22, 50), [60, 15, 5], at(22, 50));
    expect(f).toEqual([at(22, 50)]);
  });

  it('nextTrigger at exactly now rolls to tomorrow (now is not "still ahead")', () => {
    // now === lockoutTime exactly: there is no future instant left today, so
    // it must roll to tomorrow rather than returning a Date equal to `now`.
    expect(nextTrigger("22:00", at(22, 0))).toEqual(at(22, 0, 30));
  });

  it("countdownFirings with an empty leadsMin returns an empty array", () => {
    expect(countdownFirings(at(23, 0), [], at(22, 50))).toEqual([]);
  });

  it("countdownFirings drops a lead that lands exactly at now", () => {
    // 60-min lead from 23:00 lands at exactly 22:00 === now: not strictly future.
    const f = countdownFirings(at(23, 0), [60], at(22, 0));
    expect(f).toEqual([]);
  });

  it("recompress with an empty leadsMin returns an empty array, not a synthetic firing", () => {
    // There were never any leads to begin with, so there is nothing for
    // escalation to have invalidated — the empty-leads case stays empty.
    expect(recompress(at(22, 52), [], at(22, 50))).toEqual([]);
  });

  it("recompress preserves leads still legitimately in the future and only collapses the lost ones", () => {
    // Escalation pulls trigger from 23:30 to 23:00 while now=22:50.
    // Recomputed leads (60/15/5 before 23:00): 22:00, 22:45, 22:55.
    // 22:00 and 22:45 are now in the past (escalation invalidated their
    // warning window) and collapse into one immediate firing at `now`.
    // 22:55 is still genuinely in the future and must survive untouched.
    const f = recompress(at(23, 0), [60, 15, 5], at(22, 50));
    expect(f).toEqual([at(22, 50), at(22, 55)]);
  });

  it("recompress is a no-op (matches countdownFirings) when no lead was invalidated", () => {
    // Escalation barely moves the trigger; all leads are still comfortably future.
    const triggerAt = at(23, 0);
    const f = recompress(triggerAt, [60, 15, 5], at(21, 0));
    expect(f).toEqual(countdownFirings(triggerAt, [60, 15, 5], at(21, 0)));
    expect(f).toEqual([at(22, 0), at(22, 45), at(22, 55)]);
  });

  it("recompress never returns a timestamp strictly before now", () => {
    const f = recompress(at(22, 51), [60, 15, 5], at(22, 50));
    for (const t of f) {
      expect(t.getTime()).toBeGreaterThanOrEqual(at(22, 50).getTime());
    }
  });
});
