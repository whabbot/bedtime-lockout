import { describe, it, expect } from "vitest";
import {
  applyIdleSample,
  shouldEscalate,
  type ActivityState,
  type EscalationConfig,
} from "../src/main/activity";

// Arbitrary fixed base epoch-ms timestamp used as "now" for the idle-sample tests.
const t0 = new Date(2026, 5, 29, 20, 0, 0).getTime();

// Initial state: no continuous-active period yet, last sample at t0.
const start: ActivityState = { continuousActiveSinceMs: null, lastSampleMs: t0 };

const cfg: EscalationConfig = {
  enabled: true,
  earliestStart: "22:30",
  continuousUseThresholdMs: 90 * 60_000,
  idleGapToleranceMs: 5 * 60_000,
};

/**
 * Builds a Date at a given "HH:MM" time-of-day on a fixed reference date,
 * mirroring the day-rollover pattern of `nextTrigger` in scheduler.ts:
 * times before noon are treated as belonging to "the following day"
 * relative to evening times, since the bedtime window spans midnight.
 */
function late(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const day = h < 12 ? 30 : 29; // 2026-06-29 evening rolls into 2026-06-30 past-midnight
  return new Date(2026, 5, day, h, m, 0, 0);
}

describe("applyIdleSample", () => {
  it("a brief idle gap under tolerance does NOT reset the continuous clock", () => {
    let s = applyIdleSample(start, 0, t0, cfg); // active, starts the clock
    s = applyIdleSample(s, 120, t0 + 5 * 60000, cfg); // idle 2 min, tolerance 5 → no reset
    expect(s.continuousActiveSinceMs).toBe(t0);
  });

  it("an idle gap over tolerance resets the clock", () => {
    let s = applyIdleSample(start, 0, t0, cfg);
    s = applyIdleSample(s, 600, t0 + 11 * 60000, cfg); // idle 10 min > 5 → reset
    expect(s.continuousActiveSinceMs).toBe(t0 + 11 * 60000);
  });

  it("always updates lastSampleMs to nowMs regardless of reset/no-reset", () => {
    let s = applyIdleSample(start, 0, t0, cfg);
    s = applyIdleSample(s, 120, t0 + 5 * 60000, cfg);
    expect(s.lastSampleMs).toBe(t0 + 5 * 60000);
  });

  it("an idle gap exactly at tolerance does NOT reset (at-or-under tolerance keeps clock)", () => {
    let s = applyIdleSample(start, 0, t0, cfg);
    s = applyIdleSample(s, 300, t0 + 5 * 60000, cfg); // idle exactly 5 min === tolerance
    expect(s.continuousActiveSinceMs).toBe(t0);
  });

  it("an idle gap one second over tolerance resets the clock", () => {
    let s = applyIdleSample(start, 0, t0, cfg);
    s = applyIdleSample(s, 301, t0 + 5 * 60000, cfg); // idle 301s > 300s tolerance
    expect(s.continuousActiveSinceMs).toBe(t0 + 5 * 60000);
  });
});

describe("shouldEscalate", () => {
  it("escalates only after threshold AND past earliestStart", () => {
    const s = { continuousActiveSinceMs: late("22:35").getTime() - 95 * 60000, lastSampleMs: 0 };
    expect(shouldEscalate(s, late("00:10"), cfg)).toBe(true); // 95 min >= 90 threshold, after 22:30
    expect(shouldEscalate(s, late("22:00"), cfg)).toBe(false); // before earliestStart
  });

  it("does not escalate during the afternoon, even with a long continuous-active duration", () => {
    // Daytime (14:00) is never "after earliestStart" until evening arrives again —
    // this guards against a noon-anchor implementation that wraps ALL times.
    const s: ActivityState = {
      continuousActiveSinceMs: late("14:00").getTime() - 200 * 60000,
      lastSampleMs: 0,
    };
    expect(shouldEscalate(s, late("14:00"), cfg)).toBe(false);
  });

  it("escalates exactly at earliestStart once threshold is met", () => {
    const s: ActivityState = {
      continuousActiveSinceMs: late("22:30").getTime() - 90 * 60000,
      lastSampleMs: 0,
    };
    expect(shouldEscalate(s, late("22:30"), cfg)).toBe(true);
  });

  it("does not escalate one minute before earliestStart even if threshold is met", () => {
    const s: ActivityState = {
      continuousActiveSinceMs: late("22:29").getTime() - 90 * 60000,
      lastSampleMs: 0,
    };
    expect(shouldEscalate(s, late("22:29"), cfg)).toBe(false);
  });

  it("does not escalate when continuous duration is under threshold, even late at night", () => {
    const s: ActivityState = {
      continuousActiveSinceMs: late("23:00").getTime() - 10 * 60000,
      lastSampleMs: 0,
    };
    expect(shouldEscalate(s, late("23:00"), cfg)).toBe(false);
  });

  it("does not escalate when disabled, even if all other conditions are met", () => {
    const s = { continuousActiveSinceMs: late("22:35").getTime() - 95 * 60000, lastSampleMs: 0 };
    expect(shouldEscalate(s, late("00:10"), { ...cfg, enabled: false })).toBe(false);
  });

  it("does not escalate when continuousActiveSinceMs is null (no active period yet)", () => {
    const s: ActivityState = { continuousActiveSinceMs: null, lastSampleMs: 0 };
    expect(shouldEscalate(s, late("00:10"), cfg)).toBe(false);
  });
});
