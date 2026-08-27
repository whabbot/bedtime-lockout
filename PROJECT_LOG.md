# Project Log — Bedtime Lockout

Running journal of what was tried, what worked, what didn't, and what
changed along the way. Update after sessions in Claude Design / Claude Code
by reporting back here, so this stays the one place to look back on later.

---

## 2026-06-26/28 — Ideation and spec (Cowork)

**What happened:**
Worked through the core idea end-to-end before writing any code: a Mac app
that locks the screen at a chosen time and can only be dismissed by
negotiating with an LLM gatekeeper, or via a logged override phrase.

Key decisions made, in order:
- Rejected hard system shutdown (risks losing work) and plain timers
  (trivially dismissed) in favor of a focus-grabbing overlay gated by
  conversation.
- Chose `claude -p` (Claude Code CLI, print mode) as the v1 LLM backend,
  using the existing Claude subscription rather than a separate API key —
  with the model-calling logic deliberately isolated behind one function so
  swapping providers later is a contained change, not a rewrite.
- Added non-actionable countdown notifications (60/15/5 min default,
  configurable) — explicitly designed with no cancel/snooze action, since
  any actionable button there would just become the new "turn off the
  timer" escape hatch.
- Added activity-based escalation (long continuous late-night use can pull
  the lock-in time earlier than the fixed schedule).
- Worked through a real loophole: what stops someone from negotiating an
  unlock and just continuing to work? Resolved with a post-unlock state
  machine — negotiated unlocks re-arm after a grace period (itself part of
  the negotiation, capped by strictness), overrides suspend re-locking for
  the rest of the night (treated as a genuine emergency claim, not
  re-escalated), and sleep (button or LLM-triggered) is the clean resolution
  but re-locks immediately on any wake within a quick-wake window (default
  1hr) — including near-instant sleep/wake cycles, which are trivially easy
  to trigger on a Mac and don't get a pass.
- Deliberately deferred: wearable/health integration, auto-scaling
  strictness from history, true OS-level kiosk lock, Windows support,
  tracking which negotiation tactics actually work (logging outcome/method
  only in v1, not argument content).

**What worked well:**
- Asking clarifying questions before committing to mechanics (escalation
  style, data sources, interaction style) early on shaped the design a lot
  more usefully than guessing.
- Doing a deliberate "gut check" pass over the finished spec caught a real
  bug (sleep-button race condition — instant sleep/wake defeating the
  quick-wake check) and a real loophole (uncapped negotiated grace periods)
  before any code existed. Worth doing this kind of review pass again once
  v1 is implemented, against real behavior rather than just the spec text.

**What changed from earlier thinking:**
- Initially scoped "convince the user via chat" as a softer nudge; user
  pushed it to a hard lockout gated by conversation instead — a
  meaningfully different mechanic, not just a tone change.
- Override semantics flipped from the original idea: override was first
  framed as "logged, stricter next time" (a punishment), but ended up as
  "no re-lock for the rest of the night" (a release valve for genuine
  emergencies) — a deliberate tradeoff, not an oversight. Worth revisiting
  if override gets used often for non-emergencies in practice.

**Tooling notes:**
- "Claude Design" (claude.ai/design) is a separate Anthropic Labs product
  (chat + canvas, with handoff to Claude Code) — not the Vercel
  design-import MCP tool that initially loaded in this session. Good fit
  for shaping the overlay's visual look before Claude Code implementation.
- GitHub connector enabled in Claude Desktop did not surface as a tool in
  this Cowork session — connector enablement appears to be scoped
  separately between Claude Desktop chat and Cowork sessions. Used `gh` CLI
  via terminal instead, which worked fine.

**Artifacts produced this session:**
- `SPEC.md` — full v1 design spec.
- `ISSUES.md` — 15 issues drafted from the spec's open questions and
  deferred items.
- `create_issues.sh` — bulk-creates labels + all 15 issues via `gh` CLI.
- GitHub repo created: `whaibot/bedtime-lockout` (public).

**Open as of end of session:**
- Issues not yet confirmed created in the repo (script was handed to user
  to run, not yet confirmed back).
- No code written yet. Next steps: shape overlay UI in Claude Design, then
  implement in Claude Code starting from SPEC.md + the issue backlog.

---

## 2026-06-28/29 — Overlay design pass (Claude Design)

**What happened:**
Used claude.ai/design to shape the overlay UI (chat interface, countdown
state, lock visual treatment, sleep button) from SPEC.md.

**What didn't work well:**
- Design defaulted to Opus (high) for the whole session. In hindsight that
  was overkill for parts of the work — likely the simpler/repetitive
  iteration steps (small layout tweaks, minor visual variations) rather
  than the harder first-pass layout/judgment calls.

**Lesson for next time:**
Switch models more deliberately during design/iteration sessions rather
than letting one (expensive) model run the whole thing by default. Use a
lighter/faster model for routine tweaks and repetitive variations — reserve
the heaviest model for the initial design pass or genuinely novel layout
decisions. This should make iteration faster (quicker turnaround per tweak)
and more token-efficient. Exact line between "needs the heavy model" and
"doesn't" is still fuzzy — worth refining with more experience, but the
default-to-cheapest-sufficient-model habit is the main takeaway regardless
of where exactly the line ends up.

**Tooling snags:**
- Original project folder name contained an asterisk, which caused
  filesystem/tooling issues. Renamed to `bedtime-lockout` to match
  the GitHub repo. Avoid special characters in project folder names.
- `/design-login` was unavailable in the Claude Code desktop app but worked
  in the Claude Code terminal. Running it in the terminal first, then returning
to the desktop app, unblocked DesignSync there. Not documented anywhere
officially — worth trying the terminal first if the desktop app is missing
design-related slash commands.

---

## 2026-06-29 — Implementation kickoff + planning (Claude Code)

**What happened:**
First Claude Code session. Read SPEC.md + ISSUES.md in full, confirmed the
GitHub repo + all 15 issues already exist, then resolved the open questions
needed before coding and wrote the implementation plan.

**Decisions made (documented on the matching GitHub issues):**
- **#3 fail-open vs fail-closed → fail-closed** (the one decision flagged for an
  owner call). Key refinement from a review pass: the **sleep button**, not the
  override phrase, is the foregrounded escape when `claude -p` is unreachable —
  override suspends re-locking for the whole night (SPEC 81-86), so pointing a
  user at it during a transient outage would functionally be fail-open. Sleep is
  local, re-locks on quick-wake, and doesn't burn the night. Unreachable-exits
  are logged distinctly from real overrides.
- **#2 gatekeeper sessions → app-managed history + transcript replay**, not CLI
  `--resume`. `--output-format json` gives a clean `is_error` contract that
  drives fail-closed (validated). Initially couldn't validate live `--resume`
  round-trip/latency (spawned `claude -p` reported "Not logged in" until the
  user's session was active). **Later validated live:** `--resume` *does*
  round-trip context across separate invocations, and `--append-system-prompt`
  drives behavior correctly (a 'Firm, max 15 min' prompt refused a 30-min ask
  and offered exactly 15). Latency is model-dominated — haiku ≈3.4s, sonnet ≈7s
  per turn, plus a ~2–3s spawn tax each call. Kept app-managed replay anyway
  (provider-swap, crash-recovery, per-turn dynamic context); added a
  `gatekeeperModel` setting (default sonnet) and a streaming enhancement path
  (`stream-json --verbose`).
- **#1 overlay → best-effort focus-grab; durability from persistence +
  relaunch-reassert + login-item**, since no userspace macOS app can block
  force-quit (Cmd-Opt-Esc). True kiosk lock stays deferred (#14).

**Design import (claude.ai/design via DesignSync):**
- Pulled the three design files (`Bedtime Lockout.dc.html`, `Overlay.dc.html`,
  `Presence.dc.html`). Distilled into `design/DESIGN.md`; raw bundles are
  re-fetchable (pointer in `design/raw/README.md`).
- Locked in: theme `drift` (periwinkle) as default of three (ember/drift/tide),
  Onest + JetBrains Mono, an animated Presence orb (reduced-motion aware), six
  overlay modes that map 1:1 onto the post-unlock state machine, strictness
  relabeled **Gentle / Firm / Unmovable** with grace caps **45 / 15 / 5 min**.
- **Found a real design↔SPEC conflict:** the design reframes quick-wake as an
  absolute **"Wake time" (7 AM)** rather than SPEC's relative **1-hr window**
  (a 3 AM wake = fresh under SPEC, re-lock under the design). Per the rule that
  SPEC governs behavior, v1 defaults to SPEC's window but the re-lock predicate
  is parametric (`relockPolicy`), so flipping to the design's model is one line.
  **Owner chose the design's wake-time model** — v1 re-locks on any wake before
  `wakeTime` (same night), fresh after; `window` kept as a one-line fallback.

**Artifacts produced this session:**
- `docs/superpowers/plans/2026-06-29-bedtime-lockout-v1.md` — 15-task TDD plan;
  pure `now`-injected logic (scheduler/state-machine/grace/quick-wake/idle-gap/
  prompt-builder/override) with real test code, Electron glue validated manually.
- `design/DESIGN.md` + `design/raw/README.md`.
- Decision comments on issues #1, #2, #3.

**Open as of end of session:**
- No app code written yet (scaffold is Task 1 of the plan). Owner chose to
  review the plan/design docs before any code is written.
- Execution mode (subagent-driven vs inline) to be chosen at "go".

---

## 2026-06-30 — Task 1: project scaffold + minimal overlay

**What happened:**
Implemented Task 1 of the plan exactly per the task brief: `package.json`,
`tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`,
`src/main/index.ts`, `src/main/overlay.ts` (verbatim from the brief),
`src/preload/overlay-preload.ts` (minimal stub, no exposed API yet), and
`src/renderer/overlay/index.html` (placeholder).

**Environment blocker found and worked around:**
The repo's own directory name contained a literal
`*` character. esbuild (used internally by both `electron-vite` and `vite`/
`vitest` to bundle/load their own config files) treats unescaped `*` in
absolute file paths as a glob pattern. With the project's real path, esbuild
silently glob-expands and matches multiple files in the directory, then
fails with `Must use "outdir" when there are multiple input files` —
before any of the project's actual config content is even read. This broke
`npm run build`, `npm run dev`, and `npm test` identically, all failing
during config-file loading.

Root-caused via: a clean reproduction in a `*`-containing temp directory
with a trivial empty `electron.vite.config.js` (same failure), versus a
clean non-`*` temp directory (works correctly). Vite's own runtime warnings
later confirmed it explicitly: *"The project root contains the '*'
character ... Consider renaming the directory / file to remove the
characters."*

**Workaround used for verification (not a permanent fix):** created a
symlink at `/private/tmp/bedtime-link` pointing at the repo (a path with no
`*`), then ran `electron-vite build/dev` and `vitest run` with that symlink
passed explicitly as the project root. All three worked correctly through
the symlink — confirming the scaffold itself (package.json, tsconfig,
electron.vite.config.ts, overlay.ts, index.ts) is correct, and the failure
is 100% the directory name, not the code.

**Recommendation:** rename the project directory to something without a
literal `*` (e.g. `bedtime-lockout`, matching the npm package name already
chosen) for `npm run dev`/`build`/`test` to work directly without a
symlink workaround. The cheeky working title can stay in README/docs;
it just can't be the filesystem path.

**Step 5 — manual launch / visual confirmation, honest results:**
- `npm run build` (via the symlink workaround): succeeded — produced
  `out/main/index.js`, `out/preload/overlay-preload.mjs`,
  `out/renderer/overlay/index.html`.
- `npm run dev` (via the symlink workaround): main process and preload
  built successfully, Vite dev server started, and the real Electron
  binary launched (confirmed via `ps aux` — main Electron process plus
  renderer/gpu/network helper processes all running, no errors in the
  log, no `ERR_FILE_NOT_FOUND`).
- **Could NOT visually confirm** the overlay is actually fullscreen,
  always-on-top above the menu bar, kiosk-mode, or holding focus. This
  session has no interactive macOS display/login session — it's a
  non-interactive sandboxed environment. `request_access` for
  computer-use screenshot/control requires live user approval via a
  dialog, which isn't obtainable here. I confirmed the process launches
  cleanly and loads the correct renderer file with no errors, but I did
  NOT visually verify window placement, always-on-top behavior, or
  Cmd-Tab/Mission Control/Cmd-Q interception. That verification still
  needs to happen on the owner's actual machine before this is trusted.
- All spawned dev/Electron processes were killed at the end of testing;
  no `out/` build artifacts were committed (already covered by
  `.gitignore`).

**Bug fixed during scaffold (not in the brief's given code):** the brief's
`electron.vite.config.ts` description says renderer points at
`src/renderer/overlay/index.html`, but a naive `root: 'src/renderer/overlay'`
config makes Vite emit to `out/renderer/index.html` (dropping the `overlay/`
segment), which doesn't match `overlay.ts`'s `loadFile(join(__dirname,
'../renderer/overlay/index.html'))` (given verbatim, not modified). Fixed
by setting `build.outDir: resolve(__dirname, 'out/renderer/overlay')`
explicitly in the renderer section.

---

## 2026-06-30 — Task 8: askGatekeeper subprocess + fail-closed mapping (#2, #3)

**What happened:**
Implemented `ClaudeCliGatekeeper` (`src/main/gatekeeper.ts`), the live
boundary to `claude -p --output-format json`, with an injected `spawn` so
unit tests never shell out. Any unreachable condition — `is_error:true`,
non-JSON stdout, non-zero exit, or timeout — throws `GatekeeperUnreachable`
rather than returning a default, per #3's fail-closed mandate. Timeout
defaults to 30s (configurable) with exactly one retry, scoped to the
timeout case only; non-zero exit/non-JSON/`is_error` are treated as
definitive failures of that attempt and are not retried.

**Real bug caught during review (advisor pass), not by the tests as
originally written:** the implementation listened on both `'close'` and
`'exit'` to finalize stdout collection. Node's `'exit'` event can fire
*before* stdio pipes finish flushing, while `'close'` is guaranteed to fire
after — so a fast/lucky test (`data` then `close` in one microtask) could
pass while production code occasionally truncated a genuinely successful
reply into a spurious "non-JSON output" failure. Fixed by dropping the
`'exit'` listener entirely and relying on `'close'` only; added a
regression test that emits `'exit'` before `'data'`/`'close'` to lock this
in. Also narrowed retry-on-failure from "retry any failure once" to
"retry only on timeout," per the brief's literal wording — non-zero exit
and non-JSON output now fail on the first attempt (still fail-closed, just
without doubling the user's wait on a non-transient error).

**Step 5 — manual smoke test (real `claude -p`, real spawn, no fake):**
Wrote `scripts/smoke-gatekeeper.ts` (run via `npx tsx`; committed under
`scripts/` since it's small, has no runtime cost when not invoked, and
gives future sessions a ready-made way to re-verify the live `claude -p`
boundary without reconstructing the harness — not part of `npm test`, never
auto-run) that constructs a real `ClaudeCliGatekeeper` (default options, real
`node:child_process.spawn`) and calls `.ask()` with a short system prompt
and `model: 'haiku'`. Result: **succeeded in 9.6s wall-clock**, reply
"Bedtime was ten minutes ago—lights out, or we're skipping your coffee
tomorrow." This is higher than the ~3.4s haiku figure logged on 2026-06-29
(that was a raw CLI timing without our JSON round-trip/process-management
overhead); ~9.6s for haiku end-to-end is the more realistic number to
design the thinking-indicator UX around, and confirms sonnet-class turns
(thought to run ~7s+ at the CLI level alone) will need a visible
"thinking" state, not just a brief spinner.

---

## 2026-07-02 — Task 12: non-actionable countdown notifications (#4)

**What happened:**
Added `NotificationPort` to `src/main/ports.ts` and implemented it in
`src/main/notifications.ts` (`ElectronNotifier`, wrapping Electron's
`Notification` class). `notify(title, body)` deliberately constructs no
`actions` array and no custom close-button text — per #4, a countdown
notification must never look like a way to snooze or cancel the lockout,
only the OS-default dismiss. Guards on `Notification.isSupported()` first
(log-and-no-op if false) rather than let a platform/signing edge case throw
mid-countdown.

**Known platform behavior to watch for (not yet live-tested):**
macOS will show its own permission prompt the first time this app sends a
notification; if the user denies it, subsequent `.show()` calls silently do
nothing (no error surfaces). Also, per Electron's docs, unsigned development
builds are unreliable for actual notification delivery on macOS —
`Notification.isSupported()` and delivery to Notification Center are only
dependable once the app is code-signed. Both of these need a real signed
build + a live macOS session to confirm end-to-end (deferred to manual
validation, not performed in this session).

---

## 2026-07-02 (later) — Rest of v1: UI, controller, tray, packaging

**Summarised from commits, not written live** — recorded here so the log
isn't missing the stretch between Task 12 and the packaged-app work below.

Overlay chat UI with override and sleep wiring (`ba6d61b`), plus a fix for
a `hidden`-attribute CSS cascade bug and gaps in the sleep-confirm and
relock chip (`f7a456c`). Controller orchestration and startup state
reconstruction (`43ce6d1`), tray + settings UI + login-item install
(`c6b8128`, `191da4f`). Two follow-up correctness fixes found by
whole-branch review: day-rollover re-arm and `relockPolicy` default wiring
(`cccc42a`), and `WallClockTimer` reentrancy bugs exposed by the
day-rollover job (`eb0119a`). Finally `electron-builder` for local `.app`
packaging (`ed984c0`) — which is what made everything below possible.

---

## 2026-07-21 → 2026-08-27 — Packaged-app reality check

The single most useful — and most frustrating — stretch of the project.
Everything above was built and unit-tested without ever running the real
packaged `.app`. The moment we did, a run of bugs surfaced that no test in
the suite could have caught, and the debugging of them took far longer than
it should have. Two commits carry the fixes (`77577b6`, `51c5850`), but the
lessons matter more than the diffs.

**The pattern, stated up front:** every bug in this period was in the
OS-adapter layer — `index.ts`, `power.ts`, `overlay.ts`, the gatekeeper's
spawn boundary. Not one was in the domain logic. The unit suite stayed
green (166 → 185 tests) throughout a period when the app was, at times,
unusable. That split is not a coincidence: the adapters are precisely the
code that only does anything when a real packaged binary talks to a real
OS, which is exactly where unit tests cannot reach.

**What actually broke:**

- **Quit didn't quit.** The overlay window is `closable: false` and ran in
  kiosk fullscreen; both stall `app.quit()`'s graceful window-close, so the
  tray's Quit (and Cmd+Q) silently did nothing. Fixed by force-destroying
  the window on `before-quit`.
- **Gatekeeper always "unreachable" —** `spawn claude ENOENT`. A GUI /
  login-item app inherits only launchd's minimal PATH, which excludes
  `~/.local/bin` where the CLI lives, even though `claude` resolves fine in
  an interactive shell. Fixed with `resolveClaudeBin()`, probing the usual
  install locations plus PATH, with a `BEDTIME_CLAUDE_BIN` override.
- **"Sleep" was the wrong primitive.** `pmset sleepnow` only slept the
  display and was undone by a mouse nudge, landing the user back on the
  desktop rather than the overlay. Replaced with a real screen lock, which
  meant moving wake detection from `powerMonitor`'s suspend/resume to
  `unlock-screen` — a lock emits no suspend/resume at all.
- **The overlay hide saga (three failed fixes — see below).**
- **"Lock now" appeared broken, twice.** Both times the app was correctly
  sitting in `OVERRIDE_NIGHT` from an earlier override test, where the
  TRIGGER guard legitimately blocks re-locking. Not a bug — an invisible
  state. Fixed twice over: a `force: true` TRIGGER for the tray's manual
  action (a deliberate user action isn't subject to the override's
  "no re-lock tonight" promise), and a status label that says so.
- **The tray status label lied.** It was hardcoded to "Armed · locks at …"
  regardless of phase, which is *why* the override state was invisible. Now
  phase-aware: `Snoozed until 7:00 AM`, `Locked`, `Unlocked · re-locks at
  …`, `Screen locked`. Also surfaced in the tooltip.
- **The lock silently no-op'd on macOS 26.** `CGSession` — the
  Fast-User-Switching binary the lock shelled out to — no longer exists at
  its long-standing path. `spawn` failed with ENOENT into an invisible
  console. Replaced with the system Lock Screen shortcut (Ctrl-Cmd-Q) via
  System Events, which needs a one-time Accessibility grant.
- **The `claude` CLI's OAuth login had expired.** The final "gatekeeper
  isn't available" was not an app bug at all — the CLI itself failed the
  same way from a plain shell. The app behaved correctly and failed closed.

### Logging: the thing that actually broke the deadlock

A packaged GUI app has no visible stdout. For several rounds this meant
every failure was a black box, and the debugging degenerated into guessing:
change something, rebuild, ask the user to try, get "it's still broken."

The fix was a `gatekeeper-debug.log` appended under `userData`, writing a
line at every boundary: `onSendMessage` entry, context built, spawn with
the resolved binary path, each stderr chunk, close code + elapsed ms +
stdout length, and the final outcome. It converted "the gatekeeper doesn't
work" into `spawn-error: spawn claude ENOENT` in a single step. Every
mystery after that was diagnosed from one reproduction instead of a
guess-and-rebuild cycle.

**Two refinements that mattered as much as the log itself:**

- **Log payloads, not just statuses.** The first version recorded
  `process exited with code 1` and nothing else — true, and useless. Adding
  a `stdout-on-error` snippet revealed the CLI writes a structured JSON
  error (with the real, human-readable reason) *even when it exits
  non-zero* — and that the code was throwing that payload away by checking
  the exit code first. Reordered to parse JSON before trusting the exit
  code, which is what finally surfaced "Failed to authenticate: OAuth
  session expired".
- **Extend it to every OS call, not just the suspicious one.** Giving the
  lock the same treatment paid off immediately: `lock: osascript exit=1
  stderr=… osascript is not allowed to send keystrokes. (1002)` named the
  missing Accessibility permission outright, and the next line after the
  user granted it was `lock: osascript exit=0`.

### Testing decisions

- **Ports/adapters held up.** The discipline of keeping domain logic pure
  and injecting `ClockPort`/`GatekeeperPort`/`PowerMonitorPort`/`LockPort`
  is why 185 tests run in ~350ms with no Electron. The caveat learned here:
  that architecture makes the *core* trivially testable and quietly
  concentrates all the untestable risk into the thin adapter shell — so the
  shell deserves proportionally more manual and end-to-end attention, not
  less, which is the opposite of where attention naturally goes.
- **`dev.windowedOverlay`** — a settings flag that renders the overlay as a
  normal, closable, non-topmost window. Added specifically so the show/hide
  logic can be iterated without getting locked out by a bug in that same
  logic. This should have existed before the cage did.
- **`BEDTIME_CLAUDE_BIN`** was added for PATH resolution, then reused by
  the E2E suite to force deterministic gatekeeper failure by pointing it at
  `/usr/bin/false`. A seam added for one reason paying for itself in
  another is a good sign the seam was in the right place.
- **Playwright-Electron E2E** (`tests/e2e/overlay.spec.ts`): launches the
  real built main process against a seeded temp `userData` dir, drives the
  actual DOM, and asserts on the **persisted `sm.json` phase** rather than
  in-process state — so it verifies what survives a crash/restart, which is
  the property that actually matters. Covers override with the gatekeeper
  both up and down.
- **CI split by what each suite needs**: unit + DOM on ubuntu, Electron E2E
  on macOS.
- Shared Controller fakes lifted into `tests/helpers/fakes.ts` rather than
  re-declared per file.
- **A real fail-closed bug was found by writing scenario tests**: override
  didn't work when the gatekeeper was down (`3f30424`) — the one moment a
  user most needs the escape hatch.

### The three-strikes lesson (the overlay)

Worth recording in full, because it is the clearest process failure here.
The overlay-hide bug was "fixed" three times, each fix producing a
different symptom:

1. `hide()` while in kiosk → the kiosk Space is abandoned empty → **black
   screen with no desktop to return to**.
2. `setKiosk(false)` then `hide()` → the hide races the async fullscreen
   exit and is dropped → **window stays visible and follows the user across
   every desktop**.
3. Wait for `leave-full-screen`, then `hide()` → **movable, but still
   covering everything**.

The mistake was treating each as an ordering problem. The actual root cause
was that kiosk mode creates a separate macOS Space behind an async
transition *at all* — every ordering was a different way to lose the same
race. Replaced with `setSimpleFullScreen`, which just resizes the window to
fill the display: no Space, no animation, so `hide()` is an ordinary
synchronous call. Trade-off accepted deliberately: it doesn't hard-block
Cmd-Tab, which is fine for an app that already ships an override phrase —
this is friction by design, not a tamper-proof cage.

**The rule**: after two failed fixes in the same place, stop fixing and
start questioning the mechanism. The third attempt was wasted effort that a
"is this component the right one at all?" pause would have avoided.

### Diagnostic traps hit

- **Simulating the environment instead of instrumenting it.** To reproduce
  the gatekeeper failure, `claude` was run under `env -i` to mimic a GUI
  launch. It returned "Not logged in" — which turned out to be an artifact
  of the agent sandbox authenticating differently, not the real cause, and
  nearly sent the investigation down the wrong path. **You cannot reproduce
  someone else's launch/auth environment from a different context.**
  Instrument the real thing and read the log.
- **Mistaking leftover state for new bugs.** Twice, `OVERRIDE_NIGHT`
  persisted in `sm.json` from a previous test made correct behaviour look
  broken. Persistent state across test runs needs an obvious reset.
- **Trusting one happy-path run.** "That seems to be working" was reported
  after a single pass through a racy transition that then failed on the
  next cycle. Racy behaviour needs repeated cycles before it's believed.

### How we'd do this better from the start

1. **Package and run the real `.app` from day one**, not after the feature
   set is complete. Every bug in this stretch required the packaged,
   login-launched context. `npm run dev` doesn't just fail to catch them —
   it *actively hides* them, because it inherits the shell's PATH and auth.
2. **Write the boundary debug log before the first OS call**, not after the
   third mystery. It is roughly ten lines and it was the difference between
   guessing and diagnosing.
3. **Log the payload, not just the status code.** "Exited 1" is not a
   diagnosis; the error body it printed alongside is.
4. **Treat every external binary as version-dependent.** `CGSession`
   vanished in a macOS release. Check existence at call time and surface a
   real error rather than fire-and-forget spawning into a console nobody
   sees.
5. **Build the dev escape hatch before the cage.** `windowedOverlay` should
   have preceded the first fullscreen overlay.
6. **Add a state-reset affordance early** (a `[dev] Reset state` tray item),
   since persisted phase is the thing most likely to make correct code look
   broken during testing.
7. **Classify failures the user can act on, separately, from the start.**
   "Gatekeeper unavailable" and "Claude is signed out — run `claude` to
   sign in again" are the same failure to the code and completely different
   failures to the person staring at the screen.

**What genuinely worked, and should be kept:** fail-closed held under every
one of these failures — at no point did a broken gatekeeper let the user
through unchecked, and the override phrase kept working when it was down.
The core state machine needed no changes throughout. The instinct to reach
for a rewrite when the app "feels buggy" would have thrown away the working
majority and rebuilt the one genuinely hard part from zero.
