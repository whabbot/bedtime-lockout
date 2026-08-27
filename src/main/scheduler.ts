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
 * `now`) are simply dropped here — this is the "normal" path. The
 * past-or-at-now-collapses-to-one-immediate-firing behavior lives in
 * `recompress`, which is invoked specifically when escalation has pulled
 * `triggerAt` earlier and existing leads need to be recomputed.
 */
export function countdownFirings(triggerAt: Date, leadsMin: number[], now: Date): Date[] {
  const nowMs = now.getTime();

  return leadsMin
    .map((lead) => new Date(triggerAt.getTime() - lead * MINUTE_MS))
    .filter((firing) => firing.getTime() > nowMs)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Recompute countdown firings against a (possibly earlier) `triggerAt`,
 * e.g. after continuous-activity escalation pulled the lockout in. Leads
 * still strictly in the future behave exactly like `countdownFirings`.
 *
 * The trap: leads recomputed against the new `triggerAt` may now fall at-or
 * before `now` — those original warnings are moot (the lead-time has
 * already elapsed) but the user must not be left with zero warning, and we
 * must never schedule anything in the past. So: if one or more leads land
 * at-or-before `now`, they collapse into a single immediate firing at `now`
 * itself, rather than being dropped silently or scheduled in the past.
 * "Immediate firing" most naturally means "fire right now" — clamping to
 * `now` is the only value that is simultaneously (a) never in the past,
 * (b) not arbitrarily delayed past when the warning was actually due, and
 * (c) consistent with the degenerate case where `triggerAt === now`
 * (nothing to wait for at all).
 *
 * If there were no leads to begin with (e.g. `leadsMin: []`), this returns
 * an empty array — there is nothing to collapse, since collapsing only
 * applies to leads that existed and were invalidated by escalation.
 */
export function recompress(triggerAt: Date, leadsMin: number[], now: Date): Date[] {
  if (leadsMin.length === 0) {
    return [];
  }

  const nowMs = now.getTime();

  const future = countdownFirings(triggerAt, leadsMin, now);

  const hadPastOrNowLead = leadsMin.some((lead) => triggerAt.getTime() - lead * MINUTE_MS <= nowMs);

  if (!hadPastOrNowLead) {
    return future;
  }

  // At least one lead's recomputed firing time is <= now: collapse those
  // into a single immediate firing at `now`, merged with any leads that are
  // still legitimately in the future.
  return [new Date(nowMs), ...future];
}
