# Bedtime Lockout — Design Spec (v1)

## Problem

Soft self-imposed limits (timers, alarms) fail because dismissing them is a single
trivial action with zero friction — when absorbed in work, it's too easy to turn
off the timer and keep going. A harder limit (forcing the computer off) over-corrects
and risks losing unsaved work.

## Goal

A Mac app that, at a chosen time (or earlier, if late-night activity is detected),
locks the screen behind a fullscreen overlay that can only be dismissed by
negotiating your way past an LLM acting as a skeptical gatekeeper — or by using a
logged override phrase. The lock should never touch or close underlying
applications; it sits on top, and whatever you were working on is exactly as you
left it once the lock lifts.

## User Flow

1. App runs in the menu bar, idle most of the time.
2. As the configured lockout time approaches, non-actionable countdown
   notifications appear (default: 60 / 15 / 5 minutes before). These are
   informational only — no buttons, no snooze, nothing that cancels the
   upcoming lock.
3. Independently, if the app detects a long continuous active-use session late
   at night, it can escalate and bring the lock-in time forward. If this
   happens after countdown notifications have already fired, remaining
   countdown steps compress to match the new time.
4. At the trigger time, a fullscreen, always-on-top overlay appears and grabs
   focus. Underlying apps and windows are untouched and keep running
   underneath.
5. The overlay presents a chat interface. The user must negotiate with the
   LLM gatekeeper to be let through. The gatekeeper is primed with context
   (current time, how late, configured strictness) and instructed to be a
   tough, skeptical negotiator that only relents for genuinely exceptional
   reasons.
6. Saying the configured override phrase unlocks instantly, regardless of the
   conversation. This event is logged with a timestamp and surfaced to the
   gatekeeper in future sessions (e.g. "this is your third override this
   week").
7. At any point, the user (via a visible button on the overlay) or the LLM
   (if it judges the user is convinced, or if asked) can put the Mac to
   sleep directly. This is the cleanest resolution — see Post-unlock
   behavior below.
8. Once unlocked (via negotiation or override), the overlay closes and the
   user regains normal control. Nothing was forcibly closed at any point.
   What happens next depends on how the unlock happened — see Post-unlock
   behavior.

## Post-unlock behavior

Unlocking the overlay is not necessarily the end of the story for that night —
otherwise winning one negotiation is equivalent to disabling the old timer
entirely. What happens next depends on the resolution path:

- **Sleep (button or LLM-triggered):** the cleanest outcome. The Mac actually
  goes to sleep. If it's woken again within a configurable quick-wake window
  (default: 1 hour), the overlay re-fires immediately, and the gatekeeper is
  told the user went to sleep and came back within that window — treated as
  suspicious by default, full negotiation required again. Outside that
  window (e.g. the next morning), waking is treated as a normal fresh start
  — no re-lock, no special messaging. This must also catch near-instant
  wakes (Mac sleeps and is woken again within seconds/a couple minutes,
  which is trivially easy on a Mac) — these should be treated at least as
  suspiciously as any other quick-wake, not waved through because the sleep
  duration was short. The re-lock check should trigger on any wake within
  the window regardless of how long the sleep actually lasted.
- **Negotiated unlock (no sleep):** the lockout re-arms itself after a grace
  period, rather than being trusted indefinitely. The length of that grace
  period is itself part of the negotiation — e.g. if the user argued "I just
  need 10 more minutes to finish this," the gatekeeper sets the re-lock
  timer accordingly rather than a fixed system default. If the user is still
  active when the grace period elapses, the overlay fires again, with the
  prior commitment fed back in (e.g. "you said 10 minutes, it's been 25").
  The gatekeeper's strictness setting should also cap the maximum grace
  period it's willing to grant (e.g. high strictness might cap grace at 15
  minutes regardless of what's argued for) — otherwise "negotiating a grace
  period" becomes a loophole for talking your way into hours of unlocked
  time in a single exchange.
- **Override (emergency phrase):** no re-lock for the rest of that night —
  treated as a genuine emergency claim, so the system backs off rather than
  continuing to pester the user. The override is still logged, and is
  available to the gatekeeper as context in future sessions (e.g. patterns
  of frequent override use), but does not trigger same-night re-escalation.
  Lockout resumes normally the following day/night.

## Components

### Trigger
- Primary: fixed user-set daily time (e.g. 11:00pm).
- Secondary: activity-based escalation — if continuous active use is detected
  past a late-night threshold, lock-in can be brought forward.
- Both trigger types feed the same overlay/gatekeeper flow.

### Countdown notifications
- Native macOS notifications at configurable lead times before lock-in.
- Default: 60 / 15 / 5 minutes. Fully configurable list; can be disabled
  entirely.
- Strictly informational — no actions, buttons, or dismiss-triggered
  cancellation logic. Must not provide any way to cancel or delay the
  upcoming lock.
- Recompute/compress remaining steps if activity-escalation changes the
  lock-in time after some notifications have already fired.

### Overlay
- Fullscreen, always-on-top, focus-grabbing window.
- Does not quit, minimize, or otherwise touch other running applications —
  purely a visual/input layer on top.
- Hosts the chat UI for the gatekeeper negotiation.
- Includes a visible "Put Mac to sleep" button, always available regardless
  of negotiation state — a direct, one-click resolution path.
- The LLM gatekeeper can also trigger sleep itself (e.g. as a tool/action it
  can call) when it judges the user has been convinced, or when the user
  asks it to. Whether the LLM should ever do this proactively without being
  asked, versus only on request, is open — default to only-on-request or
  only-after-explicit-agreement unless later testing suggests otherwise.

### Gatekeeper (negotiation)
- Backed by `claude -p` (Claude Code CLI, print mode) for v1 — uses the
  existing Claude subscription, no separate API key needed.
- The "ask the model" call should be isolated behind a single function/module
  (e.g. `askGatekeeper(messages) -> reply`) so the backend can later be
  swapped for a direct API key or different provider without touching
  trigger, overlay, or logging code.
- System prompt includes: current time/lateness, recent lock/override
  history, and a strictness setting. Instructed to be a tough, skeptical
  negotiator, not easily swayed by simple excuses.
- Strictness is a manually configured setting in v1 (e.g. low/medium/high).
  Auto-scaling strictness from logged history is an explicit future feature
  (see Deferred).
- Multi-turn conversation — needs conversation history/session continuity
  across turns within a single lockout.

### Override
- A fixed phrase (configurable) that instantly unlocks the overlay,
  bypassing negotiation entirely.
- Every use is logged with a timestamp.
- Logged overrides are fed into future gatekeeper system prompts so repeated
  use is visible to (and can be challenged by) the negotiator.

### Data / logging
- Local-only storage (no cloud sync in v1).
- Log per lockout event: scheduled trigger time, actual trigger time
  (if escalated early), unlock time, unlock method (negotiated / override /
  sleep), conversation length/turns (optional), and — for negotiated
  unlocks — the agreed grace period before re-lock.
- Also log quick-wake events (woke within the quick-wake window after a
  lockout-triggered sleep) and same-night re-locks, so patterns like
  "regularly wakes the Mac back up within the hour" are visible later.
- Schema should leave room for future external data (e.g. wearable sleep
  data) without a redesign — but no integration in v1.

### Settings
- Fixed lockout time.
- Activity-escalation thresholds (what counts as "long continuous late-night
  use").
- Countdown notification lead times (list, or disabled).
- Override phrase.
- Gatekeeper strictness level.
- Quick-wake re-lock window after a lockout-triggered sleep (default 1 hour).

## Non-goals / Deferred (explicitly out of scope for v1)

- Wearable/health app integration (Oura, Apple Health, Fitbit, Whoop) for
  real sleep stats. Data schema should anticipate this but no integration
  now.
- Auto-scaling gatekeeper strictness based on logged override/lateness
  history. v1 strictness is manually set.
- Any OS-level kiosk/accessibility-API lock. v1 uses a focus-grabbing
  overlay window, not a true unbypassable system lock.
- Windows/cross-platform support — Mac only for v1.
- Time-boxed forced unlock or any override mechanism beyond the single fixed
  phrase.
- "What works" tracking: logging which negotiation tactics/arguments
  actually led to a successful (non-override) unlock, so the gatekeeper can
  reuse similar tactics in future sessions. Requires the data schema to
  capture more than pass/fail per lockout — e.g. a summary or classification
  of the winning argument from each negotiated unlock, fed back into future
  system prompts as "this kind of appeal has worked on you before." v1 only
  logs outcome and method, not argument content/effectiveness — this is a
  v2+ enhancement once basic logging is in place and there's enough history
  to learn from.

## Open technical questions (resolve during implementation)

- Exact Electron approach for reliable always-on-top + focus-grab behavior
  on current macOS, and how robust it is against alt-tab / force-quit
  attempts in practice.
- `claude -p` multi-turn session handling — best way to maintain
  conversation context across turns (flags vs. manually replaying history).
- Behavior if `claude -p` is unreachable (not logged in, no network): fail
  open (let the user through) or fail closed (overlay stays up with a
  static message)? Needs a decision once this edge case is reachable in
  testing.
- Best macOS API/permissions needed for native notifications from an
  Electron app, and for activity/idle detection used in the escalation
  trigger.
- How to reliably trigger actual system sleep from Electron on macOS (vs.
  just display sleep), and how to detect wake-from-sleep events so the
  quick-wake re-lock check can run (e.g. `powerMonitor` events in Electron).
- How the app persists/resumes state across an actual system sleep — e.g.
  a scheduled re-lock timer needs to survive the Mac being asleep and fire
  correctly relative to wall-clock time on wake, not just elapsed app
  runtime.
- What happens to in-flight state (active lockout, pending grace-period
  re-lock timer) across an app crash/relaunch or full system reboot. State
  needs to be persisted to disk and reconstructed on startup, not just held
  in memory — otherwise a crash or restart becomes an unintended way to
  clear a pending re-lock.
- What counts as "continuous activity" for the late-night escalation
  trigger — specifically, whether brief idle gaps (e.g. stepping away for a
  few minutes) reset the continuous-use clock or not. Needs an explicit
  idle-gap tolerance rather than being left ambiguous.
