/**
 * Pure continuous-activity accumulator: tracks how long the user has been
 * continuously active (tolerating brief idle gaps) and decides whether that
 * warrants escalating the lockout. No I/O, no Electron, no Store/EventLog,
 * no Date.now() — every function takes its time input explicitly.
 */

/** Serializable activity-tracking state, persisted via Store by a later task. */
export interface ActivityState {
  continuousActiveSinceMs: number | null;
  lastSampleMs: number;
}

/** Escalation policy config (subset of Settings['escalation'] consumed here). */
export interface EscalationConfig {
  enabled: boolean;
  earliestStart: string; // "HH:MM", 24h
  continuousUseThresholdMs: number;
  idleGapToleranceMs: number;
}

/**
 * Folds one idle-sample observation into the activity state.
 *
 * The continuous-active clock starts (or restarts) at `nowMs` whenever:
 *  - there is no continuous-active period yet (`continuousActiveSinceMs === null`), or
 *  - the idle gap since the last sample exceeds tolerance (`idleSeconds*1000 > cfg.idleGapToleranceMs`).
 *
 * Otherwise (an active sample, or an idle gap at-or-under tolerance) the
 * clock's start time is left untouched — brief idle gaps don't interrupt
 * an otherwise-continuous session. `lastSampleMs` is always advanced to
 * `nowMs` regardless of which branch is taken.
 */
export function applyIdleSample(
  state: ActivityState,
  idleSeconds: number,
  nowMs: number,
  cfg: EscalationConfig,
): ActivityState {
  const overTolerance = idleSeconds * 1000 > cfg.idleGapToleranceMs;
  const shouldStartOrReset = state.continuousActiveSinceMs === null || overTolerance;

  return {
    continuousActiveSinceMs: shouldStartOrReset ? nowMs : state.continuousActiveSinceMs,
    lastSampleMs: nowMs,
  };
}

/**
 * Compares a time-of-day ("HH:MM") against `now`, treating the window as
 * spanning midnight: anchored at noon rather than midnight, any time before
 * 12:00 is treated as belonging to "the next day" relative to an evening
 * `earliestStart`. This mirrors the day-rollover logic in `nextTrigger`
 * (scheduler.ts) for the same conceptual problem — a daily recurring
 * time-of-day boundary that `now` may fall before or after.
 *
 * Returns true iff `now`'s time-of-day is at-or-after `earliestStart` under
 * this noon-anchored ordering.
 */
function isAtOrAfterTimeOfDay(now: Date, hhmm: string): boolean {
  const [startH, startM] = hhmm.split(":").map(Number);
  const startMinutes = startH * 60 + startM;

  const nowH = now.getHours();
  const nowM = now.getMinutes();
  let nowMinutes = nowH * 60 + nowM;

  // Noon anchor: a "before noon" now is the small hours of the next day
  // relative to an evening earliestStart, so push it past midnight (+24h
  // worth of minutes) before comparing.
  if (nowH < 12) {
    nowMinutes += 24 * 60;
  }

  return nowMinutes >= startMinutes;
}

/**
 * True iff escalation is enabled, `now`'s time-of-day is at-or-after
 * `cfg.earliestStart`, and the continuous-active duration so far
 * (`now - state.continuousActiveSinceMs`) is at-or-over `cfg.continuousUseThresholdMs`.
 *
 * Returns false (rather than throwing or computing a bogus negative
 * duration) when there is no continuous-active period yet.
 */
export function shouldEscalate(state: ActivityState, now: Date, cfg: EscalationConfig): boolean {
  if (!cfg.enabled) {
    return false;
  }
  if (state.continuousActiveSinceMs === null) {
    return false;
  }
  if (!isAtOrAfterTimeOfDay(now, cfg.earliestStart)) {
    return false;
  }

  const continuousDurationMs = now.getTime() - state.continuousActiveSinceMs;
  return continuousDurationMs >= cfg.continuousUseThresholdMs;
}
