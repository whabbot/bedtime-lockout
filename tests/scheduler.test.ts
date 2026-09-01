import { describe, it, expect } from "vitest";
import { nextTrigger, countdownFirings } from "../src/main/scheduler";

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
});
