# Bedtime Lockout — Design Reference

Distilled from the Claude Design project `06757bea-31ca-46d4-b259-6651353a7dc5`
("New project spec", owner Wail). Raw source bundles are in `design/raw/`
(`Bedtime Lockout.dc.html`, `Overlay.dc.html`, `Presence.dc.html`) and can be
re-fetched any time via the `DesignSync` `get_file` method against that project
id. The `.dc.html` files use the Claude Design canvas runtime (`<x-dc>`,
`sc-if`, `sc-for`, `dc-import`, `{{ }}` props, `DCLogic`) — they are the visual
**reference**, not runnable in the Electron app. Task 13 rebuilds them as plain
renderer HTML/CSS/JS driven by IPC state.

## Tone

A warm, skeptical gatekeeper that "sits on top of your work at bedtime — never
closing anything, just gently slowing you down." Copy is calm, personal, never
punitive ("No rush. What are you still working on?"). This warmth is a design
requirement, not decoration — it carries into the gatekeeper system prompt.

## Themes (variants)

Three interchangeable palettes. **`drift` is the chosen v1 theme** (used by the
main composition). Each theme sets CSS variables consumed by the overlay.

| token        | ember (warm)                                   | **drift (chosen)**                             | tide (teal)                                    |
|--------------|------------------------------------------------|------------------------------------------------|------------------------------------------------|
| `--accent`   | `#ECA978`                                       | `#AAB6F2`                                       | `#62D9C2`                                       |
| `--accentSoft`| `rgba(236,169,120,0.16)`                       | `rgba(170,182,242,0.16)`                        | `rgba(98,217,194,0.15)`                          |
| `--text`     | `#F1E7DD`                                        | `#E9EBF3`                                        | `#E6F1ED`                                        |
| `--dim`      | `#A99C8D`                                        | `#979CB1`                                        | `#8FA8A0`                                        |
| `--bubble`   | `rgba(255,255,255,0.055)`                        | `rgba(255,255,255,0.05)`                         | `rgba(255,255,255,0.05)`                         |
| `--line`     | `rgba(255,255,255,0.08)`                         | `rgba(255,255,255,0.08)`                         | `rgba(255,255,255,0.08)`                         |
| background   | `radial-gradient(125% 95% at 50% 6%, #271A14 0%, #170F0C 56%, #100B09 100%)` | `radial-gradient(125% 95% at 50% 8%, #161A2E 0%, #0C0E1A 56%, #080913 100%)` | `radial-gradient(125% 95% at 50% 8%, #0C211D 0%, #0A1413 56%, #070D0C 100%)` |

- Root overlay: `border-radius:16px` (windowed mockup; real overlay is
  fullscreen, drop the radius), `box-shadow:0 40px 90px rgba(0,0,0,0.55)`.
- Fonts: **Onest** (400/500/600/700) for UI/prose, **JetBrains Mono** (400/500)
  for times, counts, hints, chips. Bundle both locally (no Google Fonts CDN in
  the packaged app).
- Settings window is its own darker palette: bg `#0C0F1C`, panels
  `rgba(255,255,255,0.05)`, accent `#AAB6F2`, hairlines `rgba(255,255,255,0.06)`.

## Presence orb

A calm animated focal point shown in every overlay mode, sized per mode
(248px cold → 124px during active negotiation → ~196–210px for terminal states).
Three variants matching the themes:
- **drift (chosen):** central soft glow + two counter-rotating starfields
  (`pSpin 64s` / `pSpinR 92s`) of twinkling dots — "a quiet field of stars,
  slowly turning."
- ember: breathing radial sun-glow with expanding halos.
- tide: blended aurora blobs drifting inside a circular mask.
- **Accessibility:** honors `@media (prefers-reduced-motion:reduce)` (clamps
  animation durations). Keep this in the rebuild.

## Overlay modes → state machine

The overlay component takes `mode` ∈ {cold, mid, override, sleep, relock,
quickwake}. These map directly onto the post-unlock state machine (plan Task 9):

| design mode | when | SM phase / reentry | key elements & copy |
|-------------|------|--------------------|---------------------|
| `cold`      | first lock fires | `LOCKED` (fresh) | Big orb, one-line prompt: *"It's 11:47. You meant to stop at 11:30 — so we're a little past. No rush. What are you still working on?"* Single chat input (rounded pill, accent send). "Put Mac to sleep" button. Override hint (mono): `say "let me finish tonight" to pass`. |
| `mid`       | negotiation underway | `LOCKED` (ongoing) | Smaller orb + `11:47 PM · 17 min past bedtime`. Scrolling transcript (gatekeeper = plain prose left, user = bubble right `border-radius:16px 16px 4px 16px`). Inline accept chip e.g. *"Okay — 10 minutes"*. Input: *"Tell it why you're still up…"*. Sleep button. Grace hint (mono): `grace caps at 15 min on Firm`. |
| `sleep`     | gatekeeper offers sleep | `LOCKED` → emits `SLEEP` | Transcript ending in the offer. Two buttons: primary **"Yes — put it to sleep"** + secondary **"I'll do it myself"**. Reassurance: `nothing closes · your work stays exactly as it is`. |
| `relock`    | grace elapsed | `LOCKED`, reentry `grace` | `12:12 AM · re-locked` + prior-commitment chip `earlier: "just 10 more minutes" · 11:47 PM`. Prose: *"You asked for ten minutes. It's been twenty-five. I'm not upset — but we did agree. Are you wrapping up…?"* Input + sleep + override hint. |
| `quickwake` | woke during window | `LOCKED`, reentry `quickwake` | `12:38 AM · awake 18 min after sleeping` + chip `slept 12:20 AM · wake time 7:00 AM`. Prose: *"You dozed off eighteen minutes ago, then woke the Mac back up. It's the same night, so here I am again — gently. What brought you back?"* Input + sleep + override hint. |
| `override`  | override phrase used | `OVERRIDE_NIGHT` | Desaturated orb. *"Override accepted. I'll step back for tonight."* Sub: *"No more locks until tomorrow. I've noted it — that's the third time this week, so let's talk then."* Footer (mono): `logged · override · 11:49 PM`. |

Top bar (all modes): app name + moon glyph left; fake date/time + wifi/battery
glyphs right (in the real app: real clock; OS already draws wifi/battery — the
overlay covers the menu bar, so render our own clock).

## Settings (from the main composition)

Dark settings window titled "Bedtime Lockout — Settings". Rows:
1. **Lockout time** — `{{ lockoutTime }}` (default `11:30 PM`). "When the overlay arms each night."
2. **Bring it forward if I'm still working late** — toggle (on). "Locks early after `{{ escalationMins }} min` of continuous use past **11:00 PM**. Brief breaks under **5 min** don't reset the clock." (escalationMins default 90, range 30–240 step 15.)
3. **Countdown reminders** — removable chips `60 min` `15 min` `5 min` + "add". "Quiet heads-up before lock-in. No buttons, nothing to snooze."
4. **Override phrase** — `{{ overridePhrase }}` (default `let me finish tonight`). "Say this to pass instantly. Every use is logged."
5. **Gatekeeper strictness** — segmented **Gentle / Firm / Unmovable** (default Firm). "How hard it pushes back — and the longest grace it will grant."
6. **Wake time** — `{{ wakeTime }}` (default `7:00 AM`). "Wake the Mac before this and I'll lock again — it's still the same night. After it, it's a fresh morning, no lock." (See conflict note below.)

Footer: `everything stays on this Mac · no account, no cloud`.

## Menu-bar presence (idle)

Tray popover: title "Bedtime Lockout" + green `Armed` dot. "Locks tonight at
`{{ lockoutTime }}`" big mono accent + "in 1h 43m". Rows: Tonight / Not yet
locked; Last override / `Tue · 2 nights ago`. Actions: **Lock now** (lock glyph),
**Open settings… ⌘,**, **Quit Bedtime Lockout**.

## Decisions adopted from the design (reconciled into the plan)

- **Strictness labels = Gentle / Firm / Unmovable** (replacing low/medium/high),
  with **grace caps 45 / 15 / 5 min** respectively (design's `capMap`). These
  become the v1 defaults in `Settings.graceCapsMs` and `Strictness`.
- **Default theme = drift.** Build all three palettes as swappable CSS-variable
  themes; default `drift`. (Theme choice can be a later setting; not required v1.)
- **Default lockoutTime `23:30`, wakeTime `07:00`, overridePhrase
  "let me finish tonight", escalation threshold 90 min, idle-gap tolerance 5 min,
  countdown leads 60/15/5** — all match SPEC defaults / the design.

## ⚠️ Design ↔ SPEC conflict to resolve: quick-wake window vs. wake time

- **SPEC (source of truth for behavior):** after a lockout-triggered sleep,
  re-lock if woken within a **relative quick-wake window** (default **1 hour**
  from sleep); any wake after that is a fresh start. Must catch near-instant
  wakes (#9).
- **Design:** exposes an absolute **"Wake time" (7:00 AM)** instead — re-lock on
  any wake before it (same night), fresh after.

They diverge materially: a 3 AM wake is a *fresh start* under SPEC's 1-hr window
but a *re-lock* under the design's wake-time.

**Resolved (owner decision, 2026-06-29): use the design's `wakeTime` model.**
v1 re-locks on any wake before the configured `wakeTime` (same night); a wake
at/after `wakeTime` is a fresh start. This supersedes SPEC's relative-window
default. The re-lock predicate stays parametric (`relockPolicy: 'wakeTime' |
'window'`, default `'wakeTime'`) so SPEC's window — or a hybrid (re-lock if
within window **or** before wake time) — remains a one-line settings change.
**#9 holds either way: any wake before the cutoff fires regardless of how short
the sleep was; under `wakeTime` near-instant re-wakes are always caught since
they're before morning.**
