import type { OverlayState } from "../../main/overlay-ipc";

/** Renders a Date as `H:MM AM/PM`, matching DESIGN.md's clock format (e.g. "11:47 PM"). */
export function formatClock(d: Date): string {
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  const period = d.getHours() < 12 ? "AM" : "PM";
  return `${h}:${m} ${period}`;
}

function formatIsoClock(iso: string): string {
  return formatClock(new Date(iso));
}

/** `11:47 PM · 17 min past bedtime` (mid mode's status line, per DESIGN.md). */
export function statusLine(now: Date, state: OverlayState): string {
  return `${formatClock(now)} · ${state.minutesLate} min past bedtime`;
}

export function coldProse(now: Date, state: OverlayState): string {
  return `It's ${formatClock(now)}. You're ${state.minutesLate} minute(s) past bedtime. No rush. What are you still working on?`;
}

export function relockProse(state: OverlayState): string {
  const promisedMin = state.reentry?.promisedMin;
  const promiseText =
    promisedMin !== undefined
      ? `You asked for ${promisedMin} minutes.`
      : "You asked for more time.";
  return `${promiseText} We did agree. Are you wrapping up?`;
}

export function quickwakeProse(state: OverlayState): string {
  const mins = state.reentry?.minutesSinceWake;
  const lead =
    mins !== undefined
      ? `You dozed off, then woke the Mac back up ${mins} minute(s) later.`
      : "You dozed off, then woke the Mac back up.";
  return `${lead} It's the same night, so here I am again — gently. What brought you back?`;
}

/**
 * `earlier: "just 10 more minutes" · 11:47 PM`. No field carries the user's
 * literal spoken promise, so this falls back to the last user transcript
 * line as a best-effort quote (correct only if the Controller still carries
 * the pre-grant transcript into `relock` state — not guaranteed), and finally
 * to a numeric restatement if no transcript is available at all.
 */
export function relockChip(state: OverlayState): string | null {
  const r = state.reentry;
  if (!r || r.kind !== "grace") return null;
  const lastUserMsg = [...state.transcript].reverse().find((m) => m.role === "user");
  const minText =
    lastUserMsg?.text ||
    (r.promisedMin !== undefined ? `${r.promisedMin} min granted` : "grace granted");
  const atText = r.priorCommitmentAt ? ` · ${formatIsoClock(r.priorCommitmentAt)}` : "";
  return `earlier: "${minText}"${atText}`;
}

/** `slept 12:20 AM · wake time 7:00 AM` */
export function quickwakeChip(state: OverlayState): string | null {
  const r = state.reentry;
  if (!r || r.kind !== "quickwake") return null;
  const parts: string[] = [];
  if (r.sleptAt) parts.push(`slept ${formatIsoClock(r.sleptAt)}`);
  if (r.wakeTime) parts.push(`wake time ${r.wakeTime}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function overrideHint(state: OverlayState): string {
  return `say "${state.overridePhrase}" to pass`;
}

export function graceHint(state: OverlayState): string {
  return `grace caps at ${state.graceCapMin} min on ${state.strictness}`;
}

const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third" };

function ordinal(n: number): string {
  return ORDINALS[n] ?? `${n}th`;
}

export function overrideFooter(state: OverlayState): string | null {
  const log = state.overrideLog;
  if (!log) return null;
  return `logged · override · ${formatIsoClock(log.at)}`;
}

export function overrideSubline(state: OverlayState): string {
  const count = state.overrideLog?.countThisWeek;
  if (count === undefined) {
    return "No more locks until tomorrow.";
  }
  return `No more locks until tomorrow. I've noted it — that's the ${ordinal(count)} time this week, so let's talk then.`;
}
