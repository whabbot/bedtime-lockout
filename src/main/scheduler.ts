/**
 * Pure date/time scheduling logic for the bedtime lockout trigger and its
 * countdown-warning firings. No I/O, no Electron, no Store/EventLog, no
 * Date.now()/setTimeout — every function takes `now: Date` explicitly.
 */

const MINUTE_MS = 60_000;

/**
 * Compute the next Date instance of `lockoutTime` ("HH:MM", 24h) on or after
 * `now`. If the time-of-day has already passed today, roll to tomorrow.
 */
export function nextTrigger(lockoutTime: string, now: Date): Date {
  const [hours, minutes] = lockoutTime.split(":").map(Number);

  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0,
  );

  if (candidate.getTime() > now.getTime()) {
    return candidate;
  }

  // Time-of-day already passed (or is exactly now) — roll to tomorrow.
  candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * Compute the countdown-warning firing times: `triggerAt` minus each lead
 * (in minutes), keeping only those strictly in the future relative to `now`,
 * sorted ascending. Leads that have already passed (or land exactly at
 * `now`) are simply dropped.
 */
export function countdownFirings(triggerAt: Date, leadsMin: number[], now: Date): Date[] {
  const nowMs = now.getTime();

  return leadsMin
    .map((lead) => new Date(triggerAt.getTime() - lead * MINUTE_MS))
    .filter((firing) => firing.getTime() > nowMs)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * True iff `now` falls inside tonight's lockout window — at-or-after
 * `lockoutTime` and before `wakeTime`, the window spanning midnight.
 *
 * Both boundaries are compared through `nextTrigger`, which already handles
 * the day rollover: the window is active exactly when the next wake boundary
 * arrives before the next lockout boundary.
 */
export function isWithinLockoutWindow(lockoutTime: string, wakeTime: string, now: Date): boolean {
  return nextTrigger(wakeTime, now).getTime() <= nextTrigger(lockoutTime, now).getTime();
}
