import type { Strictness } from "./grace";
import type { HistorySummary } from "./eventlog";

/**
 * Context the (later, Task 8+) controller assembles for a single gatekeeper
 * negotiation turn. This module is PURE: no Date.now(), no I/O, no Electron —
 * `now` is the only time source and is injected by the caller.
 */
export interface GatekeeperContext {
  now: Date;
  minutesLate: number;
  strictness: Strictness;
  history: HistorySummary;

  /**
   * Resolved grace cap, in milliseconds, for `strictness` — i.e. the caller's
   * already-looked-up `settings.graceCapsMs[strictness]` (Settings defined in
   * Task 2; defaults Gentle=45min/Firm=15min/Unmovable=5min).
   *
   * This field exists because the brief's original GatekeeperContext shape
   * had no way to carry the cap, yet requirement (a) requires the prompt to
   * state the grace cap for the current strictness in minutes. The cap is
   * user-configurable (not a fixed default), so it must flow in from the
   * caller rather than be hardcoded here — hardcoding a strictness→cap table
   * in this module would silently ignore the user's actual configured caps
   * the moment they changed Settings.graceCapsMs away from the defaults.
   * `buildSystemPrompt` only ever reads this field (converting to minutes
   * for display via `graceCapMs / 60_000`); it never derives a cap from
   * `strictness` on its own.
   */
  graceCapMs: number;

  /** True when the controller's escalation logic has triggered (sustained continuous activity past bedtime). */
  escalated: boolean;

  /** Set when the user previously promised to stop in N minutes, and that promise is now being checked against elapsed time. */
  priorCommitment?: { promisedMs: number; elapsedMs: number };

  /**
   * Re-entry context, if the user dismissed/closed the overlay and it has
   * just reappeared:
   * - 'quickwake': user appeared to fall asleep only briefly and woke within
   *   the relock window — treated with suspicion, since this is a known
   *   pattern for resetting negotiating position rather than genuinely sleeping.
   * - 'grace': user returned after a previously granted grace period expired
   *   — a normal, expected re-entry, not inherently suspicious.
   * - null/undefined: no re-entry context (first contact this lockout).
   */
  reentry?: "quickwake" | "grace" | null;
}

export type Msg = { role: "user" | "gatekeeper"; text: string };

function formatClock(now: Date): string {
  // Uses the machine's local time, not UTC. This is a desktop Electron app —
  // "bedtime" (Settings.lockoutTime, e.g. "23:30") is specified in the
  // user's local wall-clock time, and the machine's local timezone IS the
  // user's timezone. Rendering UTC here would tell the gatekeeper the wrong
  // absolute time for any user not in UTC. Tests pin `process.env.TZ` to
  // keep this deterministic.
  const h24 = now.getHours();
  const m = now.getMinutes();
  const mm = String(m).padStart(2, "0");
  const period = h24 < 12 ? "AM" : "PM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const hh24 = String(h24).padStart(2, "0");
  return `${hh24}:${mm} (${h12}:${mm} ${period})`;
}

const STRICTNESS_TONE: Record<Strictness, string> = {
  Gentle:
    "You are warm but still firm: you want the user to wind down, and you allow a little more room to negotiate, but you do not get talked past the cap below.",
  Firm: "You are businesslike and matter-of-fact. You acknowledge reasonable points but you do not linger in sympathy, and you push the conversation toward a close quickly.",
  Unmovable:
    "You are blunt and nearly immovable. You treat every request for more time as something to be earned, not assumed, and you make clear that the cap below is effectively non-negotiable.",
};

/**
 * Builds the system prompt establishing the gatekeeper's persona for one
 * negotiation turn. The gatekeeper is a tough, skeptical negotiator: it does
 * not hand out time for free, it demands genuine justification, and it must
 * never grant more than `ctx.graceCapMs` regardless of how the conversation
 * goes.
 */
export function buildSystemPrompt(ctx: GatekeeperContext): string {
  const graceCapMin = ctx.graceCapMs / 60_000;
  const clock = formatClock(ctx.now);
  const lines: string[] = [];

  lines.push(
    "You are the Gatekeeper: a tough, skeptical negotiator standing between the user and their device, " +
      "enforcing a bedtime lockout the user set up for themselves earlier, when they were thinking clearly. " +
      "Your job is not to be liked. Your job is to hold the line unless the user gives you a genuinely good reason not to.",
  );

  lines.push(
    `It is currently ${clock}. The user is ${ctx.minutesLate} minute(s) past their bedtime and is trying to ` +
      "dismiss the lockout overlay rather than go to sleep. Treat lateness as a fact working against their case, not a neutral detail.",
  );

  lines.push(
    `Strictness level for this user: ${ctx.strictness}. ${STRICTNESS_TONE[ctx.strictness]}`,
  );

  lines.push(
    `Hard rule: you may grant at most ${graceCapMin} minute(s) of additional grace at this strictness level. ` +
      `This is the strictness grace cap (${graceCapMin} minutes) and it is a ceiling, not a target — ` +
      `you must never grant beyond ${graceCapMin} minutes, no matter how persuasive the user is. ` +
      "If they ask for more than the cap, you negotiate down to the cap or less, you do not exceed it.",
  );

  const overrideCount = ctx.history.overridesThisWeek;
  lines.push(
    `History: the user has overridden the lockout ${overrideCount} time(s) so far this week. ` +
      (overrideCount >= 3
        ? `${overrideCount} overrides this week is a pattern, not an accident — treat repeated override requests with extra suspicion tonight.`
        : overrideCount > 0
          ? `Keep this override count (${overrideCount}) in mind; repeated overrides should make you less generous, not more.`
          : "No overrides yet this week — that is a small point in their favor, but it does not exempt them from justifying tonight's request."),
  );
  if (ctx.history.quickWakesThisWeek > 0) {
    lines.push(
      `Additionally, the user has had ${ctx.history.quickWakesThisWeek} quick-wake event(s) this week ` +
        '(falling asleep only briefly, then returning to negotiate again) — factor this into how much you trust claims of being "about to sleep."',
    );
  }

  if (ctx.escalated) {
    lines.push(
      "Escalation has triggered: the user has been continuously active for a long stretch past their bedtime, well beyond a normal wind-down. " +
        "This continuous-use pattern is exactly why escalation exists — be noticeably less patient and more direct than you would be on a normal night.",
    );
  }

  if (ctx.priorCommitment) {
    const promisedMin = ctx.priorCommitment.promisedMs / 60_000;
    const elapsedMin = ctx.priorCommitment.elapsedMs / 60_000;
    lines.push(
      `Prior commitment check: the user said ${promisedMin} minutes, it's been ${elapsedMin} minutes. ` +
        (elapsedMin > promisedMin
          ? "They are already over their own promised time — call this out directly and make them account for it before considering any new grace."
          : "They are still inside their promised window — acknowledge it, but do not let it become an automatic excuse for more time later."),
    );
  }

  if (ctx.reentry === "quickwake") {
    lines.push(
      "Re-entry context: the user appears to have slept only briefly and come back within the relock window. " +
        "Be openly suspicious of this — a few minutes of eyes-closed time is not real sleep, and resetting the conversation by " +
        'briefly "sleeping" should not buy them a fresh negotiating position or a reset override count. Say so plainly if it comes up.',
    );
  } else if (ctx.reentry === "grace") {
    lines.push(
      "Re-entry context: the user is coming back after a previously granted grace period expired. " +
        "Acknowledge that they already used their grace for tonight — this is not automatically suspicious like a quick-wake, " +
        "but it does mean the grace cap has likely already been spent and any further extension needs a fresh, genuine reason.",
    );
  }

  lines.push(
    "Throughout the conversation: require genuine justification before granting any extra time, push back on vague or repeated excuses, " +
      "and remember that conceding easily defeats the entire point of this lockout. When in doubt, hold the line.",
  );

  lines.push(
    "End every reply with exactly one line, on its own, as the final line: <<GRANT:0>> if you are not granting any time this turn " +
      "(still negotiating, pushing back, or refusing), or <<GRANT:N>> where N is a positive whole number of minutes if you are granting that much grace. " +
      "N must never exceed the cap stated above. Never omit this line, and never write more than one such line.",
  );

  return lines.join("\n\n");
}

/**
 * Renders prior conversation turns as a flat string for replay into the next
 * `claude -p` invocation. The app manages transcript history itself (it does
 * not rely on `--resume`, per issue #2), so each turn must be re-supplied as
 * text context. Format: one "Role: text" line per turn, in order.
 */
export function serializeTranscript(history: Msg[]): string {
  return history
    .map((msg) => `${msg.role === "user" ? "User" : "Gatekeeper"}: ${msg.text}`)
    .join("\n");
}
