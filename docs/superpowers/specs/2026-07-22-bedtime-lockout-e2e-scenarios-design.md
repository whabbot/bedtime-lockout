# Bedtime Lockout — End-to-End Scenario Coverage — Design

## Problem

The lockout overlay (the "Gatekeeper cage") keeps misbehaving in real use:

- It **re-appears when it shouldn't** — reported specifically on **day-rollover** and **on wake / quickwake**.
- When it *is* up, **override** and **lock** sometimes **don't work**. It's unclear whether these failures live in the app UI (renderer → IPC wiring) or in the underlying decision logic.

The codebase is already textbook ports-and-adapters: a pure `reduce()` state machine (`src/main/statemachine.ts`), a `Controller` orchestrator wired through injectable ports (`src/main/controller.ts`, `ControllerDeps`), and existing test fakes (`FakeClock` / `FakeOverlay` / `FakeLock` / `FakePower` in `tests/controller-reconstruct.test.ts`).

Unit coverage exists, yet these bugs still ship. The gap is:

1. **Multi-step timeline scenarios** through the real `Controller` spine, and
2. The **renderer**, which has untested gating logic and is run by no current test (Vitest is node-env only).

Recent fix commits (day-rollover re-arm, `WallClockTimer` reentrancy, `relockPolicy` wiring) confirm the fragility lives around rollover / re-arm / relock — exactly the reported areas.

**This is reproduce-then-fix, not add-green-coverage.** Each scenario is written as a spec of *correct* behavior, then run against current code: a red is a real reported bug to fix in the source; a green locks in a regression guard.

## Strategy: split by process boundary

The two symptom clusters live in different processes, so they need different tools.

### Clock-driven cluster (rollover / quickwake / grace-relock) → DI + `FakeClock` unit layer (Vitest)

Every bedtime decision runs in the **main** process: the state machine, `WallClockTimer.checkNow()` (a 15s `setInterval` reading the injected clock), and `ClockPort`. Production hard-wires `new SystemClock()` in `index.ts` with no env/flag/Store override, and there is no `electronApp.clock` seam — so **no launched app (Playwright or otherwise) can advance time** to reproduce a rollover or quickwake boundary.

These decisions must be driven by injecting a `FakeClock` and calling `clock.set(...)` then `timer.checkNow()`, exactly as `controller-reconstruct.test.ts` already does. Playwright's `page.clock` only instruments the **renderer** runtime, which uses time solely for the cosmetic wall-clock display — it cannot reach these decisions.

### "Override & lock don't work when the cage is up" cluster → Playwright-Electron E2E

The user is unsure whether this is renderer gating or IPC wiring. Only a launched Electron app exercises the *real* path: the contextBridge preload (`overlay-preload.ts`) → `btl:*` IPC → `Controller` handlers. A DOM-only harness (happy-dom / jsdom) would have to **stub `window.btl`**, structurally missing exactly the preload/IPC-wiring bugs the user suspects.

### Shared fakes

Reuse the `makeDeps(now)` helper and fakes from `tests/controller-reconstruct.test.ts`. Lift the shared fakes into `tests/helpers/fakes.ts` so both the reconstruct suite and the new scenario suite import them instead of duplicating.

## Phase 1 — Main-process scenario suite (`tests/scenarios.test.ts`)

Timeline tests through `Controller.dispatch` / `start`, asserting on the fakes (`overlay.show` / `hide` call counts, `lock.lockNow` count, resulting `SM.phase`, event log). Each scenario maps to one of the three complaints.

### Overlay appears when it shouldn't (rollover + wake)

- After a `NEW_DAY` rollover out of `OVERRIDE_NIGHT`, the nightly trigger re-arms and the *next* bedtime locks again — but nothing locks *at* the rollover instant.
- Quickwake past the cutoff → `WAKE` lands in `IDLE` (no overlay), and the nightly trigger is re-armed (the `dispatch` IDLE-transition hook).
- Quickwake within the cutoff → re-locks with `reentry: "quickwake"`; boundary is `now <= quickWakeUntil`. Test **both sides of the boundary** and **both `relockPolicy` values** (`wakeTime` absolute cutoff vs `quickWakeWindowMs`).
- A replayed/stale `TRIGGER` while `LOCKED` or in `OVERRIDE_NIGHT` is a no-op — protects the "no re-lock until tomorrow" guarantee.
- Escalation is suppressed before `earliestStart` and once `escalatedTonight` is set.

### Override doesn't work (logic path)

- `OVERRIDE` from `LOCKED` → `OVERRIDE_NIGHT`, `overlay.hide()` fires, override logged, and no further lock happens the rest of the night (until `NEW_DAY`).
- `onSubmitOverride` returns false on a non-matching phrase and does nothing; exact / normalized match returns true and dispatches.
- Survives restart: override, reconstruct from persisted `SM`, confirm still `OVERRIDE_NIGHT`.

### Lock doesn't work (logic path)

- `LOCK_NOW` effect → `lock.lockNow()` called exactly once (sleep path, `onSleep`).
- Tray "Lock now" (`triggerNow`, `force: true`) locks even from non-IDLE phases.
- Grace expiry re-locks via `armRelock` → `TICK` when `checkNow()` runs past `relockAt`.

## Phase 2 — Playwright-Electron E2E suite (`tests/e2e/overlay.spec.ts`)

Launch the real built app and drive the overlay through its real preload → IPC → Controller path. This is the only layer that can tell renderer gating apart from IPC wiring — the two places the "override & lock don't work" failure could live.

### Setup (Playwright's own runner, not Vitest)

- Add `@playwright/test` as a devDependency and a `playwright.config.ts`; add a `test:e2e` script (`playwright test`). `electron-vite build` must run first so `out/main/index.js` exists.
- Launch via `_electron.launch({ args: ["out/main/index.js"], ... })`. Give each run a fresh temp `userData` dir (Electron `--user-data-dir` arg) and **seed its Store JSON before launch** so the cage is testable:
  - `dev.windowedOverlay: true` → the overlay renders as the tame closable 1000×800 window instead of the screen-saver-level fullscreen cage that would otherwise trap the test session.
  - A persisted `sm` in phase `LOCKED` → the Controller reconstructs into a locked night on boot and **shows the overlay immediately** (`reconstruct()` calls `overlay.show()` + `pushCurrentState()` for `LOCKED`), no clock advance needed.
- Reach the overlay window via `electronApp.firstWindow()` / `windows()`; assert main-side outcomes with `electronApp.evaluate(...)` where a DOM assertion isn't enough.

### Guardrails (things Phase 2 must NOT do)

- **Do not drive the sleep → lock path in Phase 2.** There is no lock bypass seam: `index.ts` wires the real `MacScreenLock`, and `LOCK_NOW` → `screenLock.lockNow()` would lock the *actual test machine's screen* mid-run, killing the session. All real-lock coverage stays in Phase 1 with `FakeLock`. Phase 2 drives only the override and gatekeeper-down paths, which never emit `LOCK_NOW`.
- **Do not drive the live LLM.** `onSendMessage` spawns the real Claude CLI. Launch with a `PATH` / env that makes the spawn fail so `onSendMessage` returns `{ unreachable: true }` (verify during implementation that a broken spawn resolves unreachable rather than hanging).

### Assertions (each maps to a reported failure)

- **Override works when the cage is up:** type the override phrase, submit, expect the app to transition to `OVERRIDE_NIGHT` (assert via `electronApp.evaluate` on the persisted `sm` / observe the overlay hide).
- **Prime suspect — override works *even when the gatekeeper is down*:** first submit a chat message so the failed CLI round-trip drives the renderer into gatekeeper-down. Note that `setGatekeeperDown` does *not* re-render, so the real bug is expected to be purely the override submit-handler early-return in `main.ts`, not the disabled-attribute path. Then submit the override phrase and assert it **still transitions to `OVERRIDE_NIGHT`**. Expect this red today; fix the source (drop the `gatekeeperDown` guard from the override submit) and confirm green in the real app.
- The real preload bridge and `btl:*` channels round-trip. This replaces a separate static channel-name contract test — the E2E now proves the wiring at runtime, so a rename that breaks the UI fails here loudly.

## Triage & fix loop (do not stop at "tests written")

1. Write each scenario / spec as correct-behavior.
2. Run `npm test` (Phase 1) and `npm run test:e2e` (Phase 2). Triage every failure:
   - Red on a reported symptom (rollover overlay, quickwake, override-when-gatekeeper-down) → fix the **source**, not the assertion.
   - Green → keep as regression guard.
3. For any source fix, follow systematic-debugging: confirm the failing test reproduces the bug first, then fix, then confirm green.

## Critical files

- **New:** `tests/scenarios.test.ts` (Phase 1), `tests/helpers/fakes.ts`, `tests/e2e/overlay.spec.ts` + `playwright.config.ts` (Phase 2).
- **Modified:** `package.json` (`@playwright/test` devDep, `test:e2e` script). Vitest config stays node-only — no DOM env is added.
- **Likely source fixes (pending triage):** `src/renderer/overlay/main.ts` (override gating when gatekeeper down), and whichever rollover / quickwake seam a red exposes in `src/main/controller.ts` / `src/main/statemachine.ts`.
- **Reuse:** `matchOverride` (`override.ts`), `nextTrigger` (`scheduler.ts`), `WallClockTimer.checkNow` (`timers.ts`), the fakes in `controller-reconstruct.test.ts`; the `dev.windowedOverlay` seam (`overlay.ts`, `index.ts`, `settings.ts`) and `win.loadFile` (`overlay.ts`) that make the app Playwright-launchable.

> **Note on line references:** The plan this spec is derived from cited specific `file:line` locations. Recent fix commits (day-rollover re-arm, `WallClockTimer` reentrancy, `relockPolicy` wiring) may have shifted those lines, so line numbers are intentionally omitted here. Spot-verify the seams above against current source at execution time rather than trusting any cached line number.

## Verification

- `npm test` green (Phase 1 DI scenarios) and `npm run test:e2e` green (Phase 2 launched app).
- Every reported symptom has at least one named test; each source fix is proven by a test that was red before the fix and green after.
- The override-when-gatekeeper-down fix is proven in the real overlay by the Phase 2 E2E itself (it drives the real preload → IPC path), so no separate manual sanity-run is required — though a quick `/run` is still worth doing once at the end.
