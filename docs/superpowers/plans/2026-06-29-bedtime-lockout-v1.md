# Bedtime Lockout v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS menu-bar app that, at a chosen time (or earlier on detected late-night activity), throws up a focus-grabbing overlay dismissible only by negotiating with an LLM gatekeeper (`claude -p`) or a logged override phrase, with a post-unlock state machine that re-arms the lock so winning one negotiation isn't equivalent to disabling it.

**Architecture:** Electron app. The **main process** owns all logic, scheduling, persistence, power/idle monitoring, notifications, and the `claude -p` subprocess. The **renderer** is the fullscreen overlay (chat UI + override input + sleep button), talking to main over a narrow contextBridge IPC surface. All decision logic (scheduler math, post-unlock state machine, grace capping, quick-wake detection, idle-gap accounting, prompt building, override matching) lives in **pure, `now`-injected functions** with no Electron dependency, so it can be unit-tested in milliseconds and a full night cycle can be exercised in seconds. Electron glue (window flags, powerMonitor, Notification, `pmset`) is thin and validated manually — no fake unit tests forced onto it.

**Tech Stack:** Electron (latest stable, ≥33), TypeScript, electron-vite (main/preload/renderer bundling), Vitest (unit tests for the pure logic), `claude -p --output-format json` as the v1 LLM backend.

## Global Constraints

These apply to **every** task. Exact values copied from SPEC.md and the resolved issue decisions.

- **macOS only.** No cross-platform code paths (Windows is deferred — #15).
- **LLM access only behind `askGatekeeper(messages) => Promise<reply>`.** No task other than the gatekeeper module may shell out to `claude` or any model API. Swapping the backend later must be a one-file change.
- **Fail-closed when `claude -p` is unreachable** (resolved #3). On `is_error`/timeout/not-logged-in the overlay stays up; the **sleep button is the foregrounded local escape** (it re-locks on quick-wake, doesn't burn the night); the override phrase stays available but secondary; unreachable-exits are logged **distinctly** from genuine overrides.
- **Gatekeeper conversation history is app-managed** (resolved #2): replay the transcript each turn via `--append-system-prompt` + serialized prior turns. (CLI `--resume` is validated to round-trip context, but app-managed replay is chosen for provider-swap, crash-recovery, and per-turn dynamic-context reasons — see issue #2.) Default model `sonnet` (`gatekeeperModel` setting; `haiku` faster/weaker). Parse `--output-format json`; treat `is_error === true` (or non-zero exit / parse failure / timeout) as unreachable. Live latency ≈3.4s (haiku) / 7s (sonnet) per turn incl. a ~2–3s spawn tax → thinking indicator mandatory; `stream-json --verbose --include-partial-messages` is the streaming-enhancement path.
- **All decision logic is pure and takes `now: Date` (or `nowMs: number`) explicitly.** No `Date.now()` / `setTimeout` inside logic modules. Time and OS effects are injected.
- **All durations are configurable down to the second/millisecond**, so a full night cycle (countdown → lock → negotiate → grace re-lock → sleep → quick-wake) can be tested in minutes. Defaults are spec defaults; tests override them to seconds.
- **OS effect sources are injected behind interfaces** — `PowerMonitorPort` (suspend/resume/getSystemIdleTime), `SleepPort` (sleepNow), `NotificationPort`, `ClockPort`, `GatekeeperPort` — so suspend/resume/idle can be fired synthetically in tests without sleeping the Mac.
- **All in-flight state is persisted to disk and reconstructed on startup** (#7). A crash, force-quit, or reboot must NOT clear a pending lockout or pending re-lock. Timers are wall-clock (absolute-timestamp) based and re-validated on wake (#6), never reliant on `setTimeout` surviving sleep.
- **Strictness** is a manual setting: `Gentle | Firm | Unmovable` (labels from the design; `Firm` default). It caps the maximum negotiated grace period (#10). Default caps (from the design's `capMap`): Gentle = 45 min, Firm = 15 min, Unmovable = 5 min.
- **Visual design is in [design/DESIGN.md](../../design/DESIGN.md)** (distilled from the Claude Design project). Default theme `drift` (periwinkle `#AAB6F2`); fonts Onest + JetBrains Mono bundled locally; six overlay modes (cold/mid/sleep/relock/quickwake/override) map 1:1 onto the state-machine phases; animated Presence orb honors `prefers-reduced-motion`.
- **Quick-wake re-lock uses the `wakeTime` model** (owner decision, 2026-06-29): after a lockout-triggered sleep, re-lock on ANY wake before the configured `wakeTime` (same night); a wake at/after `wakeTime` is a fresh start. The predicate is still parametric (`relockPolicy: 'wakeTime' | 'window'`, default `'wakeTime'`) so SPEC's relative-window model remains a one-line fallback. This supersedes SPEC's window default; see DESIGN.md.
- **Countdown notifications are strictly non-actionable** — no buttons, no snooze, nothing that cancels or delays the lock. Default leads: 60 / 15 / 5 min before trigger.
- **Quick-wake re-lock fires on ANY wake before the re-lock cutoff regardless of sleep duration** (#9), including near-instant sleep/wake. Cutoff = `wakeTime` (default model) or `now+quickWakeWindowMs` (window fallback). Under the `wakeTime` default, near-instant re-wakes are trivially covered since they're always before morning.
- **Data schema leaves room for future external (wearable) data** (#11) without redesign — events carry an open `meta` object and a schema `version`.

### Default settings (the canonical `Settings` shape, defined in Task 2)

```ts
interface Settings {
  schemaVersion: 1;
  lockoutTime: string;            // "23:30" local, daily fixed trigger
  wakeTime: string;               // "07:00" — used when relockPolicy === 'wakeTime'
  theme: 'ember' | 'drift' | 'tide'; // default 'drift'
  countdownLeadsMin: number[];    // [60, 15, 5]; [] disables countdowns
  overridePhrase: string;         // default "let me finish tonight"
  strictness: Strictness;         // 'Gentle' | 'Firm' | 'Unmovable', default 'Firm'
  gatekeeperModel: 'sonnet' | 'haiku'; // default 'sonnet' (better negotiator); haiku ≈2x faster, weaker
  relockPolicy: 'wakeTime' | 'window'; // default 'wakeTime' (owner-chosen, design model); 'window' = SPEC fallback
  quickWakeWindowMs: number;      // default 3_600_000 (60 min), used only when relockPolicy==='window'
  graceCapsMs: { Gentle: number; Firm: number; Unmovable: number }; // 45/15/5 min
  escalation: {
    enabled: boolean;             // default true
    earliestStart: string;       // "22:30": activity before this doesn't escalate
    continuousUseThresholdMs: number; // default 90 min of continuous active use
    idleGapToleranceMs: number;  // default 5 min — idle longer than this resets the clock (#8)
    pollIntervalMs: number;      // default 30s idle-time poll
  };
  // testing/override hooks: any duration may be set to seconds in tests
}
```

---

## File Structure

```
package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts, .gitignore
src/
  main/
    index.ts              # app entry, lifecycle, login-item install, wires everything
    ports.ts              # interfaces: ClockPort, PowerMonitorPort, SleepPort, NotificationPort, GatekeeperPort
    store.ts              # atomic JSON persistence under userData (settings, state, log)
    settings.ts          # Settings type, DEFAULTS, load/validate/merge (pure where possible)
    eventlog.ts          # append-only event log; schema w/ version + open `meta`
    clock.ts             # SystemClock implements ClockPort (real wall clock)
    timers.ts            # WallClockTimer: schedule against absolute ts, persist, re-check on resume/interval (#6)
    scheduler.ts         # PURE: next trigger, countdown firings, escalation recompression
    grace.ts             # PURE: capGrace(requestedMs, strictness, caps) (#10)
    statemachine.ts      # PURE: post-unlock state machine (the heart) — reducer (state,event,now)->(state,effects)
    activity.ts          # PURE: continuous-use accumulator w/ idle-gap tolerance + escalation detection (#8)
    gatekeeper-prompt.ts # PURE: buildSystemPrompt(ctx), serializeTranscript(history)
    gatekeeper.ts        # askGatekeeper(): spawn claude -p, parse json, fail-closed mapping (#2,#3)
    override.ts          # PURE: matchOverride(input, phrase)
    power.ts             # SystemPower implements PowerMonitorPort+SleepPort (powerMonitor, pmset sleepnow) (#5)
    notifications.ts     # SystemNotifications implements NotificationPort (Electron Notification, non-actionable) (#4)
    overlay.ts           # BrowserWindow: fullscreen+alwaysOnTop+kiosk, focus-grab, quit interception (#1)
    tray.ts              # menu-bar presence, open settings, manual "lock now"/quit (dev)
    controller.ts        # orchestrator: drives state machine from events, owns timers, reconstructs on startup (#7)
  preload/
    overlay-preload.ts   # contextBridge: sendMessage,onReply,submitOverride,requestSleep,onState,onGatekeeperDown
  renderer/
    overlay/             # the overlay UI (imported Claude Design .dc.html, adapted) — chat, override, sleep button
    settings/            # minimal settings UI
tests/                   # vitest specs mirroring src/main logic modules
```

**Task → issue mapping:** T1→#1, T6→#4(notif part)/#5, T7→scheduler, T8→#10, T9→state machine(#9 quick-wake, grace re-arm, override semantics), T10→#8, T11→#2/#3, T12→#4(idle)/#8 wiring, T13→#7/#6, T14→override, T2/T3→#7 persistence/#11 schema.

---

## Task 1: Project scaffold + minimal always-on-top overlay (validates #1)

**Files:**
- Create: `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/main/index.ts`, `src/main/overlay.ts`, `src/preload/overlay-preload.ts`, `src/renderer/overlay/index.html`

**Interfaces:**
- Produces: `createOverlayWindow(): BrowserWindow` (fullscreen, always-on-top, kiosk, focus-grabbed), `app` bootstrap.

- [ ] **Step 1: Init project and install deps**

```bash
npm init -y
npm i -D electron electron-vite vite typescript vitest @types/node
```
Set `"main": "out/main/index.js"`, `"type": "module"`, and scripts:
```json
"scripts": { "dev": "electron-vite dev", "build": "electron-vite build", "start": "electron-vite preview", "test": "vitest run", "test:watch": "vitest" }
```

- [ ] **Step 2: tsconfig + electron.vite.config.ts + vitest.config.ts**

`tsconfig.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `strict true`, `outDir out`, `types ["node"]`.
`electron.vite.config.ts`: three sections (main/preload/renderer) pointing at the entries above.
`vitest.config.ts`: `test.environment 'node'`, `test.include ['tests/**/*.test.ts']`.

- [ ] **Step 3: Minimal overlay window**

```ts
// src/main/overlay.ts
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

export function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false, fullscreen: true, kiosk: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false, minimizable: false,
    closable: false, focusable: true, hasShadow: false,
    webPreferences: { preload: join(__dirname, '../preload/overlay-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');           // above the menu bar
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
  win.focus();
  return win;
}
```

- [ ] **Step 4: index.ts boots and shows the overlay (temporary, for the spike)**

```ts
// src/main/index.ts
import { app } from 'electron';
import { createOverlayWindow } from './overlay';
app.whenReady().then(() => { createOverlayWindow(); });
app.on('window-all-closed', () => {}); // do NOT quit on close in v1
```
`index.html`: a centered placeholder ("Bedtime Lockout — overlay spike").

- [ ] **Step 5: Launch and visually confirm always-on-top (manual)**

Run: `npm run dev`
Expected: a fullscreen window covering the screen and menu bar, on top of other apps, holding focus. **Manually probe** Cmd-Tab, Mission Control, Cmd-Q (should be intercepted later), and note force-quit (Cmd-Opt-Esc) WILL kill it — that's expected and is why durability comes from persistence + relaunch-reassert (#1 decision). Record observations in PROJECT_LOG.md.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/bedtime-lockout-v1
git add -A && git commit -m "feat: scaffold electron app + minimal always-on-top overlay (#1)"
```

---

## Task 2: Settings + atomic store (persistence foundation, #7)

**Files:** Create `src/main/store.ts`, `src/main/settings.ts`, `src/main/ports.ts`; Test `tests/settings.test.ts`, `tests/store.test.ts`

**Interfaces:**
- Produces: `DEFAULTS: Settings`; `mergeSettings(partial): Settings`; `Store` class with `read<T>(key, fallback): T`, `write(key, value): void` (atomic: write tmp + rename); `ClockPort { now(): Date }`.

- [ ] **Step 1: Failing test — defaults + partial merge**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULTS, mergeSettings } from '../src/main/settings';
describe('settings', () => {
  it('fills missing fields from defaults', () => {
    const s = mergeSettings({ lockoutTime: '22:45' });
    expect(s.lockoutTime).toBe('22:45');
    expect(s.quickWakeWindowMs).toBe(DEFAULTS.quickWakeWindowMs);
    expect(s.graceCapsMs.high).toBe(15 * 60_000);
  });
  it('rejects an invalid lockoutTime by falling back to default', () => {
    expect(mergeSettings({ lockoutTime: '99:99' }).lockoutTime).toBe(DEFAULTS.lockoutTime);
  });
});
```
- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/settings.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `settings.ts`** with the `Settings` interface from Global Constraints, `DEFAULTS`, and `mergeSettings` (deep-merge + validate `HH:MM`, positive durations).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Store atomic-write test + impl**

```ts
it('round-trips a value and survives a re-read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'btl-'));
  const s = new Store(dir);
  s.write('state', { phase: 'LOCKED' });
  expect(new Store(dir).read('state', null)).toEqual({ phase: 'LOCKED' });
});
```
`Store.write` writes to `key.json.tmp` then `renameSync` (atomic) so a crash mid-write can't corrupt state.
- [ ] **Step 6: Commit** — `feat: settings schema + atomic store (#7)`

---

## Task 3: Event log + data schema (#11 room for external data)

**Files:** Create `src/main/eventlog.ts`; Test `tests/eventlog.test.ts`

**Interfaces:**
- Produces: `EventLog` with `append(ev: LockoutEvent): void`, `recent(sinceMs): LockoutEvent[]`, `summaryForGatekeeper(now): HistorySummary`.
- `LockoutEvent` union (schema version 1):
```ts
type LockoutEvent =
  | { v:1; kind:'lockout'; scheduledAt:string; actualAt:string; escalated:boolean; meta?:object }
  | { v:1; kind:'unlock'; at:string; method:'negotiated'|'override'|'sleep'; turns?:number; graceMs?:number; meta?:object }
  | { v:1; kind:'override'; at:string; meta?:object }
  | { v:1; kind:'quickwake'; at:string; sleptMs:number; meta?:object }
  | { v:1; kind:'relock'; at:string; reason:'grace'|'quickwake'; meta?:object }
  | { v:1; kind:'gatekeeper_unreachable'; at:string; reason:string; meta?:object };
```

- [ ] **Step 1: Failing test** — append 3 overrides this week; `summaryForGatekeeper` reports `overridesThisWeek === 3`. Append a `gatekeeper_unreachable`; assert it is NOT counted as an override (distinct logging, per #3).
- [ ] **Step 2–4:** Implement append (delegates to `Store`), `recent`, `summaryForGatekeeper` (counts overrides this week, last lockout, quick-wake frequency). Run → pass.
- [ ] **Step 5: Commit** — `feat: event log + versioned schema with open meta (#11)`

---

## Task 4: Scheduler — next trigger, countdown firings, escalation recompression (PURE)

**Files:** Create `src/main/scheduler.ts`; Test `tests/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `nextTrigger(lockoutTime: string, now: Date): Date`
  - `countdownFirings(triggerAt: Date, leadsMin: number[], now: Date): Date[]` — only future firings, sorted.
  - `recompress(triggerAt: Date, leadsMin: number[], now: Date): Date[]` — when escalation moves `triggerAt` earlier, drop any lead that would fall in the past and collapse those whose firing time is ≤ now into an immediate single firing (never schedule in the past). **This is the sneakiest correctness trap — it gets its own tests.**

- [ ] **Step 1: Failing tests (cover the trap)**

```ts
import { nextTrigger, countdownFirings, recompress } from '../src/main/scheduler';
const at = (h:number,m:number,d=29)=> new Date(2026,5,d,h,m,0);

it('nextTrigger picks today if time is still ahead', () => {
  expect(nextTrigger('23:00', at(22,0))).toEqual(at(23,0));
});
it('nextTrigger rolls to tomorrow if time already passed', () => {
  expect(nextTrigger('23:00', at(23,30))).toEqual(at(23,0,30));
});
it('countdownFirings returns only future leads, sorted ascending', () => {
  const f = countdownFirings(at(23,0), [60,15,5], at(22,50));
  expect(f).toEqual([at(22,55), /* 5-min */ ]); // 60 & 15 already passed at 22:50
});
it('recompress collapses now-or-past leads to a single immediate firing', () => {
  // escalation pulls trigger to 22:52 while it is already 22:50; leads 60/15/5
  const f = recompress(at(22,52), [60,15,5], at(22,50));
  expect(f.every(t => t.getTime() >= at(22,50).getTime())).toBe(true);
  expect(f.length).toBe(1);                 // only the 5-min-ish window survives, collapsed
  expect(f[0].getTime()).toBeLessThanOrEqual(at(22,52).getTime());
});
it('recompress with trigger in <1s schedules immediate, never negative', () => {
  const f = recompress(at(22,50), [60,15,5], at(22,50));
  expect(f).toEqual([at(22,50)]);
});
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the three pure functions. Guard: any firing `< now` is either dropped or clamped to `now` per the collapse rule; never emit a past timestamp.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat: scheduler with countdown compression on escalation`

---

## Task 5: Grace cap (PURE, #10)

**Files:** Create `src/main/grace.ts`; Test `tests/grace.test.ts`

**Interfaces:** `type Strictness = 'Gentle'|'Firm'|'Unmovable'`; `capGrace(requestedMs: number, strictness: Strictness, caps: GraceCaps): number` — returns `min(max(requestedMs,0), caps[strictness])`.

- [ ] **Step 1: Failing test**
```ts
const caps = { Gentle: 45*60000, Firm: 15*60000, Unmovable: 5*60000 };
it('caps requested grace at the strictness ceiling', () => {
  expect(capGrace(45*60000, 'Firm', caps)).toBe(15*60000);   // asked 45, Firm caps at 15
  expect(capGrace(10*60000, 'Firm', caps)).toBe(10*60000);   // under cap → honored
  expect(capGrace(30*60000, 'Unmovable', caps)).toBe(5*60000); // Unmovable caps hard at 5
  expect(capGrace(-5, 'Gentle', caps)).toBe(0);              // negative → 0
});
```
- [ ] **Step 2–4:** Implement, run, pass.
- [ ] **Step 5: Commit** — `feat: cap negotiated grace by strictness (#10)`

---

## Task 6: Activity accumulator — idle-gap tolerance + escalation (PURE, #8)

**Files:** Create `src/main/activity.ts`; Test `tests/activity.test.ts`

**Interfaces:**
- `ActivityState` (serializable): `{ continuousActiveSinceMs: number | null; lastSampleMs: number }`.
- `applyIdleSample(state, idleSeconds, nowMs, cfg): ActivityState` — updates continuous-active clock; if `idleSeconds*1000 > cfg.idleGapToleranceMs` the clock resets (brief gaps under tolerance do NOT reset). (#8)
- `shouldEscalate(state, now: Date, cfg): boolean` — true iff `now` ≥ `earliestStart`, escalation enabled, and continuous-active duration ≥ `continuousUseThresholdMs`.

- [ ] **Step 1: Failing tests (the idle-gap decision is the point)**
```ts
it('a brief idle gap under tolerance does NOT reset the continuous clock', () => {
  let s = applyIdleSample(start, 0, t0, cfg);          // active
  s = applyIdleSample(s, 120, t0 + 5*60000, cfg);       // idle 2 min, tolerance 5 → no reset
  expect(s.continuousActiveSinceMs).toBe(t0);
});
it('an idle gap over tolerance resets the clock', () => {
  let s = applyIdleSample(start, 0, t0, cfg);
  s = applyIdleSample(s, 600, t0 + 11*60000, cfg);      // idle 10 min > 5 → reset
  expect(s.continuousActiveSinceMs).toBe(t0 + 11*60000);
});
it('escalates only after threshold AND past earliestStart', () => {
  const s = { continuousActiveSinceMs: late('22:35').getTime() - 95*60000, lastSampleMs: 0 };
  expect(shouldEscalate(s, late('00:10'), cfg)).toBe(true);   // 95 min ≥ 90 threshold, after 22:30
  expect(shouldEscalate(s, late('22:00'), cfg)).toBe(false);  // before earliestStart
});
```
- [ ] **Step 2–4:** Implement, run, pass.
- [ ] **Step 5: Commit** — `feat: continuous-activity accumulator with idle-gap tolerance (#8)`

---

## Task 7: Gatekeeper prompt builder (PURE, #2)

**Files:** Create `src/main/gatekeeper-prompt.ts`; Test `tests/gatekeeper-prompt.test.ts`

**Interfaces:**
- `GatekeeperContext { now: Date; minutesLate: number; strictness: Strictness; history: HistorySummary; escalated: boolean; priorCommitment?: { promisedMs: number; elapsedMs: number }; reentry?: 'quickwake'|'grace'|null }`
- `buildSystemPrompt(ctx): string` — tough, skeptical negotiator; injects time/lateness, strictness, override history, and (when present) prior-commitment / quick-wake re-entry framing. Must state the grace cap for the current strictness so the model never grants beyond it.
- `serializeTranscript(history: Msg[]): string` — render prior turns for replay (since we manage history ourselves, #2).
- `Msg = { role:'user'|'gatekeeper'; text:string }`

- [ ] **Step 1: Failing tests** — assert the system prompt: (a) contains the strictness grace cap in minutes; (b) when `history.overridesThisWeek===3`, mentions the override count; (c) when `reentry==='quickwake'`, contains language framing the user as having slept and come back within the window (treated as suspicious); (d) when `priorCommitment` present, surfaces "you said N minutes, it's been M".
- [ ] **Step 2–4:** Implement, run, pass.
- [ ] **Step 5: Commit** — `feat: gatekeeper system-prompt builder (#2)`

---

## Task 8: askGatekeeper subprocess + fail-closed mapping (#2, #3)

**Files:** Create `src/main/gatekeeper.ts`, extend `src/main/ports.ts` (`GatekeeperPort`); Test `tests/gatekeeper.test.ts`

**Interfaces:**
- `GatekeeperPort { ask(systemPrompt: string, transcript: string, userMsg: string, opts?: { model?: 'sonnet'|'haiku'; onDelta?: (text: string) => void }): Promise<string> }` — throws `GatekeeperUnreachable` on failure.
- `class ClaudeCliGatekeeper implements GatekeeperPort` — spawns `claude -p --model <model> --output-format json --append-system-prompt <sys> <prompt>`; parses stdout JSON; if `is_error === true`, non-zero exit, parse failure, or timeout (default 30s with one retry, per #3) → throw `GatekeeperUnreachable(reason)`. **Streaming (enhancement):** when `onDelta` is provided, use `--output-format stream-json --verbose --include-partial-messages` and emit text deltas to `onDelta` (cuts perceived latency on ~7s sonnet turns); the final `result` is still returned. Ship the plain-`json` path first.
- A `spawnFn` is injected so tests don't shell out.

- [ ] **Step 1: Failing tests (inject a fake spawn)**
```ts
it('returns result text on success json', async () => {
  const gk = new ClaudeCliGatekeeper({ spawn: fakeSpawn({ is_error:false, result:'No. Go to sleep.' }) });
  expect(await gk.ask('sys','', 'please')).toBe('No. Go to sleep.');
});
it('throws GatekeeperUnreachable on is_error json (drives fail-closed)', async () => {
  const gk = new ClaudeCliGatekeeper({ spawn: fakeSpawn({ is_error:true, result:'Not logged in · Please run /login' }) });
  await expect(gk.ask('sys','', 'please')).rejects.toBeInstanceOf(GatekeeperUnreachable);
});
it('throws GatekeeperUnreachable on non-JSON / crash output', async () => {
  const gk = new ClaudeCliGatekeeper({ spawn: fakeSpawnRaw('segfault') });
  await expect(gk.ask('sys','', 'please')).rejects.toBeInstanceOf(GatekeeperUnreachable);
});
```
- [ ] **Step 2–4:** Implement subprocess spawn + JSON parse + error mapping (the `is_error` contract validated in the #2/#3 spike), run, pass.
- [ ] **Step 5: Manual smoke (machine logged into Claude Code):** a tiny script that calls `ask()` for real, confirming a live reply and measuring latency; record latency in PROJECT_LOG.md (informs the thinking-indicator UX).
- [ ] **Step 6: Commit** — `feat: askGatekeeper claude -p backend, fail-closed on unreachable (#2,#3)`

---

## Task 9: Override match (PURE) + post-unlock state machine (PURE — the heart) (#9, grace, override)

**Files:** Create `src/main/override.ts`, `src/main/statemachine.ts`; Test `tests/override.test.ts`, `tests/statemachine.test.ts`

**Interfaces:**
- `matchOverride(input: string, phrase: string): boolean` — case-insensitive, trimmed, whitespace-collapsed exact match (not substring, to avoid accidental trips).
- State machine reducer:
```ts
type Phase = 'IDLE'|'COUNTDOWN'|'LOCKED'|'GRACE'|'OVERRIDE_NIGHT'|'SLEEP_WATCH';
interface SM { phase: Phase; triggerAt?: number; relockAt?: number; quickWakeUntil?: number; lastPromiseMs?: number; }
type Event =
  | {t:'TICK'; now:number}
  | {t:'TRIGGER'; now:number; escalated:boolean}
  | {t:'NEGOTIATED_UNLOCK'; now:number; graceMs:number}   // graceMs already capped (Task 5) by caller
  | {t:'OVERRIDE'; now:number}
  | {t:'SLEEP'; now:number; quickWakeUntil:number}         // cutoff resolved by caller per relockPolicy (wakeTime epoch or now+window)
  | {t:'WAKE'; now:number}
  | {t:'NEW_DAY'; now:number};
interface Effect { type:'SHOW_OVERLAY'|'HIDE_OVERLAY'|'SLEEP_NOW'|'ARM_RELOCK'|'LOG'; payload?:any; reentry?:'grace'|'quickwake' }
function reduce(s: SM, e: Event): { state: SM; effects: Effect[] };
```

**Semantics to encode (from SPEC Post-unlock):**
- `TRIGGER` → `LOCKED` + `SHOW_OVERLAY`.
- `NEGOTIATED_UNLOCK(graceMs)` from LOCKED → `GRACE` with `relockAt = now + graceMs`, `lastPromiseMs = graceMs` + `HIDE_OVERLAY`.
- `TICK` in GRACE where `now ≥ relockAt` → `LOCKED` + `SHOW_OVERLAY{reentry:'grace'}` (prior commitment fed back).
- `OVERRIDE` from LOCKED → `OVERRIDE_NIGHT` + `HIDE_OVERLAY` + `LOG(override)`; **no re-lock until `NEW_DAY`** (no TICK re-lock in this phase).
- `SLEEP` from LOCKED (or GRACE) → `SLEEP_WATCH` with `SLEEP_NOW` + `HIDE_OVERLAY`. `quickWakeUntil` is computed by a parametric predicate: `relockPolicy==='wakeTime'` (default) → next `wakeTime` epoch; `relockPolicy==='window'` → `now + quickWakeWindowMs` (fallback). The reducer takes the resolved `quickWakeUntil` from the caller so the SM stays pure; both policies funnel through the same `WAKE`-within-`quickWakeUntil` check below (so #9 holds identically for either).
- `WAKE` in SLEEP_WATCH where `now ≤ quickWakeUntil` → `LOCKED` + `SHOW_OVERLAY{reentry:'quickwake'}` + `LOG(quickwake)`. **This MUST fire regardless of how long the sleep lasted** — the window is wall-clock from sleep start, so even a 2-second sleep/wake re-locks (#9). `WAKE` after `quickWakeUntil` → `IDLE` (fresh morning, no re-lock, no special messaging).
- `NEW_DAY` → `IDLE` (clears OVERRIDE_NIGHT suppression).

- [ ] **Step 1: Failing tests — override match**
```ts
it('matches case-insensitively and trimmed, not as substring', () => {
  expect(matchOverride('  Let Me Through Tonight ', 'let me through tonight')).toBe(true);
  expect(matchOverride('please let me through tonight now', 'let me through tonight')).toBe(false);
});
```
- [ ] **Step 2: Failing tests — state machine (each semantic above is one test). The #9 test is mandatory:**
```ts
const SLEEP_AT_MIDNIGHT = {t:'SLEEP' as const, now:0, quickWakeUntil: 8*3600000}; // cutoff = 8 AM
it('quick-wake re-locks even on a near-instant sleep/wake', () => {
  let { state } = reduce(locked(0), SLEEP_AT_MIDNIGHT);
  const r = reduce(state, {t:'WAKE', now:2000});                // woke after 2 SECONDS, before cutoff
  expect(r.state.phase).toBe('LOCKED');
  expect(r.effects.find(e=>e.type==='SHOW_OVERLAY')?.reentry).toBe('quickwake');
});
it('wake at/after the cutoff is a clean fresh start, no re-lock', () => {
  let { state } = reduce(locked(0), SLEEP_AT_MIDNIGHT);
  expect(reduce(state, {t:'WAKE', now: 9*3600000}).state.phase).toBe('IDLE'); // 9 AM > 8 AM cutoff
});
it('grace re-arms and re-locks with prior commitment when it elapses', () => {
  let { state } = reduce(locked(0), {t:'NEGOTIATED_UNLOCK', now:0, graceMs:10*60000});
  expect(state.phase).toBe('GRACE');
  const r = reduce(state, {t:'TICK', now: 10*60000 + 1});
  expect(r.state.phase).toBe('LOCKED');
  expect(r.effects.find(e=>e.type==='SHOW_OVERLAY')?.reentry).toBe('grace');
});
it('override suppresses re-lock for the rest of the night', () => {
  let { state } = reduce(locked(0), {t:'OVERRIDE', now:0});
  expect(state.phase).toBe('OVERRIDE_NIGHT');
  expect(reduce(state, {t:'TICK', now: 5*60*60000}).state.phase).toBe('OVERRIDE_NIGHT'); // still no relock
  expect(reduce(state, {t:'NEW_DAY', now: 8*60*60000}).state.phase).toBe('IDLE');
});
```
- [ ] **Step 3–4:** Implement `reduce` to satisfy all semantics. Pure, serializable `SM` (so it persists, #7). Run, pass.
- [ ] **Step 5: Commit** — `feat: post-unlock state machine + override match (#9, grace re-arm, override semantics)`

---

## Task 10: Wall-clock timers (#6) + clock port

**Files:** Create `src/main/clock.ts`, `src/main/timers.ts`; Test `tests/timers.test.ts`

**Interfaces:**
- `SystemClock implements ClockPort { now(): Date }`.
- `WallClockTimer`: schedule callbacks against **absolute** epoch targets, persisted via `Store`. A coarse interval (e.g. every 15s) plus an explicit `checkNow()` (called on `resume`) compares `clock.now()` to each target and fires any that have passed. **Never** relies on a single long `setTimeout` surviving sleep.

- [ ] **Step 1: Failing test** — set a target 10 min out; advance an injected clock past it and call `checkNow()`; assert the callback fired exactly once; assert targets persist and reload reconstructs pending timers.
- [ ] **Step 2–4:** Implement, run, pass.
- [ ] **Step 5: Commit** — `feat: wall-clock timers that survive system sleep (#6)`

---

## Task 11: Power port — real sleep + wake detection (#5) [glue, manual]

**Files:** Create `src/main/power.ts` (implements `PowerMonitorPort` + `SleepPort`)

**Interfaces:** `sleepNow(): void` runs `pmset sleepnow` via `child_process` (actual system sleep, not display sleep). `onResume(cb)`, `onSuspend(cb)`, `getSystemIdleTime(): number` wrap Electron `powerMonitor`.

- [ ] **Step 1: Implement** the wrappers; `sleepNow` spawns `pmset sleepnow`.
- [ ] **Step 2: Manual validation** — wire a dev tray item "sleep now"; confirm the Mac actually sleeps; on wake, confirm `powerMonitor` `resume` fires and the controller's quick-wake check runs (validates #5 end-to-end with Task 9's logic). Record in PROJECT_LOG.md.
- [ ] **Step 3: Commit** — `feat: system sleep via pmset + wake detection via powerMonitor (#5)`

---

## Task 12: Notifications — non-actionable countdown (#4) [glue, manual]

**Files:** Create `src/main/notifications.ts` (implements `NotificationPort`)

**Interfaces:** `notify(title, body): void` using Electron `Notification` with **no `actions`/buttons**. Document the macOS notification-permission prompt on first send (and that a signed app is needed for reliable delivery) in PROJECT_LOG.md (#4).

- [ ] **Step 1: Implement** non-actionable notification.
- [ ] **Step 2: Manual validation** — trigger a countdown notification; confirm it shows with no buttons and nothing that cancels the lock.
- [ ] **Step 3: Commit** — `feat: non-actionable countdown notifications (#4)`

---

## Task 13: Overlay IPC + renderer wiring (chat, override, sleep button)

**Files:** Create `src/preload/overlay-preload.ts`, build out `src/renderer/overlay/` (the imported Claude Design UI, adapted); extend `src/main/overlay.ts` with IPC handlers.

**Interfaces (contextBridge `window.btl`):** `sendMessage(text)`, `onReply(cb)`, `onThinking(cb)`, `submitOverride(text)`, `requestSleep()`, `onState(cb)`, `onGatekeeperDown(cb)`.

- [ ] **Step 1:** preload exposes the narrow API; main registers `ipcMain.handle` routes that call `askGatekeeper`, override match, and emit sleep requests into the controller.
- [ ] **Step 2:** Renderer — rebuild the imported design (now in `design/DESIGN.md`; raw bundles re-fetchable per `design/raw/README.md`) as plain HTML/CSS/JS driven by the IPC `onState` payload. **One overlay template, six visual modes** keyed off state: cold (fresh lock), mid (active transcript), sleep (sleep offer w/ "Yes — put it to sleep" / "I'll do it myself"), relock (prior-commitment chip), quickwake (slept/wake chip), override (desaturated orb, "I'll step back for tonight"). Theme via CSS variables (default `drift`); bundle Onest + JetBrains Mono locally; port the Presence orb incl. `prefers-reduced-motion`. Must include: chat transcript (gatekeeper prose left, user bubble right), input pill, a **thinking indicator** (multi-second latency, #2), a foregrounded **"Put Mac to sleep"** button, override hint/secondary field. On `onGatekeeperDown`: disable chat, show the static fail-closed notice, foreground the sleep button (#3). The renderer is presentational only — all state transitions come from the main-process state machine, never computed client-side.
- [ ] **Step 3: Manual validation** — full negotiation round-trip in the live overlay (needs Task 8 + logged-in machine).
- [ ] **Step 4: Commit** — `feat: overlay chat UI + override + sleep button wiring`

---

## Task 14: Controller — orchestrator, startup reconstruction (#7), timer wiring (#6)

**Files:** Create `src/main/controller.ts`; rewrite `src/main/index.ts` to wire ports → controller; Test `tests/controller-reconstruct.test.ts`

**Interfaces:** `class Controller` takes all ports (`ClockPort`, `PowerMonitorPort`, `SleepPort`, `NotificationPort`, `GatekeeperPort`, `Store`, `EventLog`) + an overlay handle. It: loads persisted `SM` + settings on startup; if phase is `LOCKED`/`GRACE`/`SLEEP_WATCH`, **re-asserts** the overlay or re-arms the relock immediately (so crash/force-quit/reboot can't clear a pending lockout, #7); subscribes to `resume` → `timers.checkNow()` + state-machine `WAKE`; runs the activity poll → escalation → `TRIGGER`; persists `SM` after every `reduce`.

- [ ] **Step 1: Failing test — reconstruction** — persist an `SM` in `GRACE` with `relockAt` in the past; construct a `Controller` with a clock past `relockAt`; assert it re-locks on startup (emits `SHOW_OVERLAY`), proving a restart can't escape a pending re-lock (#7). Persist `LOCKED`; assert overlay re-asserts on startup.
- [ ] **Step 2–4:** Implement reconstruction + event wiring against injected ports (no real Electron in the test). Run, pass.
- [ ] **Step 5: Manual validation** — run a compressed full cycle (durations in seconds): countdown → lock → negotiate → grace re-lock → sleep → quick-wake → override → new day. Force-quit mid-lock and relaunch; confirm the lock re-asserts. Record in PROJECT_LOG.md.
- [ ] **Step 6: Commit** — `feat: controller orchestration + startup state reconstruction (#7,#6)`

---

## Task 15: Tray + settings UI + login-item install

**Files:** Create `src/main/tray.ts`, `src/renderer/settings/`; extend `index.ts`.

- [ ] **Step 1:** Menu-bar tray: status, open settings, (dev) "lock now"/"sleep now", quit. Settings UI edits the `Settings` shape (Task 2) and persists via `Store`.
- [ ] **Step 2:** Install as a login item (`app.setLoginItemSettings({ openAtLogin: true })`) so force-quitting and not reopening is non-trivial (supports the #1 durability story).
- [ ] **Step 3: Manual validation** — edit settings, confirm persistence; confirm relaunch-on-login.
- [ ] **Step 4: Commit** — `feat: tray + settings UI + login-item install`

---

## Self-Review (run against SPEC.md)

**Spec coverage check:**
- Fixed-time trigger → T4 (`nextTrigger`) + T14. ✓
- Activity escalation + idle-gap → T6 + T14 (#8). ✓
- Countdown notifications, non-actionable, recompressed on escalation → T4 (`recompress`) + T12 (#4). ✓
- Overlay fullscreen/always-on-top/no-touch underlying apps → T1 + T13 (#1). ✓
- Gatekeeper `claude -p`, isolated behind `askGatekeeper`, multi-turn history → T7 + T8 (#2). ✓
- Override phrase, instant unlock, logged, fed to future prompts → T9 + T3 + T7. ✓
- Sleep (button or LLM) as clean resolution → T9 (`SLEEP`) + T11 + T13. ✓
- Post-unlock: negotiated grace (capped) → T5 + T9; override no-relock-night → T9; sleep + quick-wake incl. near-instant → T9 (#9) + T11. ✓
- Grace cap by strictness → T5 (#10). ✓
- Logging schema w/ room for external data → T3 (#11). ✓
- Settings (all fields) → T2 + T15. ✓
- Persistence across sleep/crash/reboot, wall-clock timers → T2/T10/T14 (#6,#7). ✓
- Fail-closed on unreachable gatekeeper → T8 (#3). ✓

**Deferred (correctly absent):** wearable integration (#11 schema only), auto-scaling strictness (#12), tactic tracking (#13), OS kiosk lock (#14), Windows (#15).

**Placeholder scan:** none — logic tasks carry real test code; glue tasks carry exact Electron APIs + manual validation steps (the honest test for un-unit-testable OS glue).

**Type consistency:** `Settings`, `SM`/`Phase`/`Event`/`Effect`, `LockoutEvent`, `GatekeeperPort`, `ClockPort` are defined once and referenced consistently across tasks. `graceMs` passed to the state machine is already capped by `capGrace` at the call site (T14), keeping #10 enforcement in one place.
