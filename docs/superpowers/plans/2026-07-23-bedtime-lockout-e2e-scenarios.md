# Bedtime Lockout — End-to-End Scenario Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the lockout overlay's override/lock/rollover behavior across three test layers, reproduce-then-fix the one live bug (override fails when the gatekeeper is down), and lock the rest in as regression guards.

**Architecture:** Three layers, each proving what the others structurally cannot.
- **L1 — main-process logic (Vitest, node-env):** drives the `Controller`/`reduce()` spine with injected fakes. Owns every clock-driven decision (rollover / quickwake / relock) — no launched app can advance the hard-wired `SystemClock`.
- **L2 — renderer DOM logic (Vitest, per-file happy-dom):** loads the real `src/renderer/overlay/main.ts` in a DOM with a stubbed `window.btl`, and proves the renderer's *gating* — that a form submit reaches `btl.submitOverride`, and that `render()` leaves the escape hatch usable. This is where the live gating bug is reproduced and fixed, red-green.
- **L3 — full-stack E2E (Playwright-Electron):** launches the real built app and drives the overlay through its real preload → `btl:*` IPC → `Controller` path. Owns the *wiring* proof — the round-trip actually reaches `OVERRIDE_NIGHT` — which a stubbed-`btl` DOM harness cannot give.

The user reported "override & lock don't work when the cage is up" without knowing whether the fault was **renderer gating** or **IPC wiring**. L2 proves gating; L3 proves wiring. Keeping them as two layers is what tells those two failure modes apart with no duplication.

**Tech Stack:** TypeScript, Electron, electron-vite, Vitest (existing) + `happy-dom` (new, L2 only, per-file), `@playwright/test` + `_electron` (new, L3 only).

## Global Constraints

- **The clock-driven cluster is already green.** `npm test` is 169/169. Recent fix commits (day-rollover re-arm, `WallClockTimer` reentrancy, `relockPolicy` wiring) already closed the rollover/quickwake/relock bugs. Per the spec's own rule — *"reproduce-then-fix, not add-green-coverage"* — do **not** re-implement scenarios `controller-reconstruct.test.ts` / `statemachine.test.ts` / `activity.test.ts` already cover. L1 here is fakes-DRY + the few genuinely-uncovered edges as regression guards. The live bug is at L2/L3.
- **Vitest is node-env by default; the renderer layer opts in per file.** Do **not** switch the global Vitest environment. The L2 file (Task 3) declares `// @vitest-environment happy-dom` as its first line — that is the only DOM-env file, and it exists to *complement* the E2E layer (proving gating faster and covering the render-disable path E2E cannot reach), not to replace it.
- Reuse the existing fakes and `makeDeps(now)` — never duplicate them.
- **L3 must never drive the sleep → lock path.** `index.ts` wires the real `MacScreenLock`; `LOCK_NOW` → `screenLock.lockNow()` would lock the actual test machine's screen mid-run. All real-lock coverage stays in L1 with `FakeLock`. L3 drives only the override and gatekeeper-down paths, which never emit `LOCK_NOW`.
- **L3 must never drive the live LLM.** Launch with `BEDTIME_CLAUDE_BIN=/usr/bin/false` — the file exists so `resolveClaudeBin` uses it, it exits non-zero, and `onSendMessage` resolves `{ unreachable: true }` deterministically. (Do not rely on breaking `PATH`: `resolveClaudeBin` hard-probes `/opt/homebrew/bin` and `/usr/local/bin` regardless of `PATH`.)
- Every source fix must be proven by a test that was red before the fix and green after (systematic-debugging).
- **All suites must run in GitHub Actions.** L1 + L2 (`npm test`, pure node — the happy-dom file needs no browser) run on `ubuntu-latest`. L3 (`npm run test:e2e`) runs on `macos-latest` — the app's real target: it constructs a menu-bar `Tray` and its lock is macOS `CGSession`, so a macOS runner avoids Linux tray/`xvfb` flakiness and needs no virtual display. Playwright-Electron launches the app's own Electron binary, so **no `npx playwright install` browser download is needed**. `resolveClaudeBin` + `BEDTIME_CLAUDE_BIN=/usr/bin/false` are portable across both runners.

---

### Task 1: Lift shared fakes into `tests/helpers/fakes.ts`

Pure refactor. Moves the fakes + `makeDeps` out of `controller-reconstruct.test.ts` so the new scenario suite imports them instead of duplicating. Must stay 169/169 green.

**Files:**
- Create: `tests/helpers/fakes.ts`
- Modify: `tests/controller-reconstruct.test.ts` (delete the inline fake classes + `makeDeps` + `persistNoEscalationSettings`; import them instead)

**Interfaces:**
- Produces: `FakeClock` (`constructor(ms)`, `now(): Date`, `set(ms)`, `advance(ms)`), `FakePower`, `FakeLock` (`locked: number`), `FakeNotifier`, `FakeGatekeeper` (`replies: string[]`, `throwUnreachable: boolean`, `calls`), `FakeOverlay` (`shown: number`, `hidden: number`, `states: OverlayState[]`, `gatekeeperDown: number`, `thinking: boolean[]`, `last(): OverlayState`), `makeDeps(now: number, dir: string): ControllerDeps`, `persistNoEscalationSettings(store: Store): void`.

- [ ] **Step 1: Create `tests/helpers/fakes.ts`**

Move the fake classes and helpers verbatim from `controller-reconstruct.test.ts` into this new module, adding `export` to each class/function. Preserve behavior exactly — this is a cut-and-paste with `export` added, not a rewrite. The header imports:

```typescript
import { Store } from "../../src/main/store";
import { EventLog } from "../../src/main/eventlog";
import { GatekeeperUnreachable } from "../../src/main/gatekeeper";
import { DEFAULTS } from "../../src/main/settings";
import type { OverlayHandle, ControllerDeps } from "../../src/main/controller";
import type { OverlayState } from "../../src/main/overlay-ipc";
import type {
  ClockPort,
  GatekeeperPort,
  LockPort,
  NotificationPort,
  PowerMonitorPort,
} from "../../src/main/ports";
```

Note the `../../` depth (one level deeper than the old `../` because the file now lives in `tests/helpers/`). If `ControllerDeps` is not currently exported from `src/main/controller.ts`, export it there in this step (it is the `deps` parameter type of the `Controller` constructor).

- [ ] **Step 2: Update `tests/controller-reconstruct.test.ts` to import from the helper**

Delete the inline `class FakeClock`, `FakePower`, `FakeLock`, `FakeNotifier`, `FakeGatekeeper`, `FakeOverlay`, `function makeDeps`, and `function persistNoEscalationSettings` blocks. Replace with:

```typescript
import {
  FakeClock,
  FakePower,
  FakeLock,
  FakeNotifier,
  FakeGatekeeper,
  FakeOverlay,
  makeDeps,
  persistNoEscalationSettings,
} from "./helpers/fakes";
```

Keep every `it(...)` body unchanged. Remove now-unused imports (`ClockPort`, `GatekeeperUnreachable`, etc.) if the file no longer references them directly.

- [ ] **Step 3: Run the full suite to verify the refactor is behavior-preserving**

Run: `npm test`
Expected: `Test Files 13 passed (13)`, `Tests 169 passed (169)` — identical to baseline.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/fakes.ts tests/controller-reconstruct.test.ts src/main/controller.ts
git commit -m "test: lift shared Controller fakes into tests/helpers/fakes.ts"
```

---

### Task 2: Regression guards for the two genuinely-uncovered logic edges

Adds only the edges the existing L1 suites miss: the **exact** quickwake boundary (`now === quickWakeUntil`), and that reconstructing a persisted `OVERRIDE_NIGHT` does **not** re-show the cage or re-lock. Both are expected to pass on current code — they are regression guards, not reproductions. Do not re-add scenarios already covered (near-instant quickwake, past-cutoff, stale/force TRIGGER, NEW_DAY clearing, `shouldEscalate` — all already green).

**Files:**
- Create: `tests/scenarios.test.ts`

**Interfaces:**
- Consumes: `reduce` and `SM` from `src/main/statemachine.ts`; `Controller` from `src/main/controller.ts`; `makeDeps`, `persistNoEscalationSettings`, `FakeOverlay` from `tests/helpers/fakes.ts`; `Store` from `src/main/store.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduce, type SM } from "../src/main/statemachine";
import { Controller } from "../src/main/controller";
import { Store } from "../src/main/store";
import { makeDeps, persistNoEscalationSettings, FakeOverlay } from "./helpers/fakes";

const HOUR = 3_600_000;
const locked = (triggerAt: number): SM => ({ phase: "LOCKED", triggerAt, escalated: false });

describe("scenarios — quickwake boundary is inclusive at exactly quickWakeUntil", () => {
  const CUTOFF = 8 * HOUR;
  const sleep = { t: "SLEEP" as const, now: 0, quickWakeUntil: CUTOFF };

  it("wake at exactly quickWakeUntil re-locks (boundary is now <= quickWakeUntil)", () => {
    const { state } = reduce(locked(0), sleep);
    const r = reduce(state, { t: "WAKE", now: CUTOFF });
    expect(r.state.phase).toBe("LOCKED");
    expect(r.effects.find((e) => e.type === "SHOW_OVERLAY")?.reentry).toBe("quickwake");
  });

  it("wake one ms past quickWakeUntil is a clean fresh start", () => {
    const { state } = reduce(locked(0), sleep);
    expect(reduce(state, { t: "WAKE", now: CUTOFF + 1 }).state.phase).toBe("IDLE");
  });
});

describe("scenarios — reconstructing OVERRIDE_NIGHT does not re-cage or re-lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "btl-scenarios-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots into OVERRIDE_NIGHT with no overlay shown and no lock", () => {
    const store = new Store(dir);
    persistNoEscalationSettings(store);
    const sm: SM = { phase: "OVERRIDE_NIGHT" };
    store.write("sm", sm);

    const deps = makeDeps(1_000_000, dir);
    const controller = new Controller(deps);
    controller.reconstruct();

    const overlay = deps.overlay as FakeOverlay;
    expect(overlay.shown).toBe(0);
    expect(deps.lock.locked).toBe(0);
    expect(controller.snapshot().phase).toBe("OVERRIDE_NIGHT");

    controller.stop();
  });
});
```

- [ ] **Step 2: Run to see them pass (guards, not reproductions)**

Run: `npx vitest run tests/scenarios.test.ts`
Expected: all PASS. If the OVERRIDE_NIGHT test errors on `controller.reconstruct()` / `controller.snapshot()`, open `src/main/controller.ts` and match the real method names (the reconstruct entry point and the public phase accessor) — adjust the calls, do not change the assertions' intent. If `SM` for `OVERRIDE_NIGHT` requires more fields, read its definition in `src/main/statemachine.ts` and supply them.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all files pass; `scenarios.test.ts` appears in the count.

- [ ] **Step 4: Commit**

```bash
git add tests/scenarios.test.ts
git commit -m "test: guard exact quickwake boundary + OVERRIDE_NIGHT reconstruct"
```

---

### Task 3: Renderer DOM layer — reproduce → fix → green the override gating bug

The live bug lives in the renderer's gating logic. This task loads the **real** `src/renderer/overlay/main.ts` in a happy-dom DOM with a stubbed `window.btl`, reproduces the gating failure **red** at two spots, applies the fix in the source, and confirms **green** — all at Vitest speed, no launched app. It also guards that chat *stays* gated (the fix must not open the wrong door).

This layer proves **gating** (does the renderer *call* `submitOverride` with the gatekeeper down?). It cannot prove **wiring** (does that call actually reach `OVERRIDE_NIGHT`?) because `window.btl` is stubbed — that is L3's job (Task 6).

**Why the module loads cleanly under happy-dom:** `main.ts`'s only main-process imports are `import type { OverlayState }` and `import type { Msg }` (verified) — both are erased at compile time, so importing `main.ts` pulls no `electron` code. Its runtime imports are `./copy` (pure) and the DOM. So the module runs in happy-dom given a populated DOM and a `window.btl` stub.

**Module load-time behavior that dictates the harness (verified in `main.ts`):**
- ~20 `document.getElementById(...)` grabs run at module top level → the DOM must be populated **before** import, or they return `null` and the module throws.
- `tickClock(); setInterval(tickClock, 1000);` runs at import → use fake timers so the interval doesn't leak.
- `window.btl.onState(render)`, `.onThinking(...)`, `.onGatekeeperDown(setGatekeeperDown)`, `.onReply(...)` register at module top level (`main.ts:158-161`) → the `btl` stub must exist **before** import and must implement all four registration methods, or the module throws.
- `gatekeeperDown` is a module-scoped `let` flipped by `setGatekeeperDown()` and never reset → each test needs a **fresh module instance** (`vi.resetModules()` per test).

**Files:**
- Create: `tests/overlay-renderer.test.ts`
- Modify: `package.json` (add `happy-dom` devDependency)
- Modify: `src/renderer/overlay/main.ts:200` and `src/renderer/overlay/main.ts:136-141` (the fix)

**Interfaces:**
- Consumes: `DEFAULTS.overridePhrase` from `src/main/settings.ts`; `OverlayState` from `src/main/overlay-ipc.ts`; the real DOM ids in `src/renderer/overlay/index.html` (`override-text`, `override-form`, `input-text`, `input-form`, `gatekeeper-down`); the `BtlApi` surface (`sendMessage`, `submitOverride`, `requestSleep`, `onState`, `onThinking`, `onGatekeeperDown`, `onReply`) from `src/preload/overlay-preload.ts`.

- [ ] **Step 1: Install happy-dom**

Run: `npm install --save-dev happy-dom`

- [ ] **Step 2: Write the failing tests**

Create `tests/overlay-renderer.test.ts`. The `// @vitest-environment happy-dom` docblock **must be the first line of the file** (Vitest only reads the env docblock from the top-of-file comment).

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/main/settings";
import type { OverlayState } from "../src/main/overlay-ipc";

const HTML = readFileSync(join(process.cwd(), "src/renderer/overlay/index.html"), "utf8");
const BODY_HTML = HTML.replace(/[\s\S]*?<body[^>]*>/, "")
  .replace(/<\/body>[\s\S]*/, "")
  .replace(/<script[\s\S]*?<\/script>/g, "");

function coldState(): OverlayState {
  return {
    mode: "cold",
    minutesLate: 0,
    strictness: "Firm",
    graceCapMin: 15,
    overridePhrase: DEFAULTS.overridePhrase,
    transcript: [],
  };
}

interface Loaded {
  handlers: {
    onState?: (s: OverlayState) => void;
    onGatekeeperDown?: () => void;
    onThinking?: (t: boolean) => void;
    onReply?: (r: string) => void;
  };
  submitOverride: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  requestSleep: ReturnType<typeof vi.fn>;
}

async function loadOverlay(): Promise<Loaded> {
  document.body.innerHTML = BODY_HTML;

  const handlers: Loaded["handlers"] = {};
  const submitOverride = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn().mockResolvedValue({ unreachable: true });
  const requestSleep = vi.fn();

  (window as unknown as { btl: unknown }).btl = {
    sendMessage,
    submitOverride,
    requestSleep,
    onState: (cb: (s: OverlayState) => void) => {
      handlers.onState = cb;
    },
    onThinking: (cb: (t: boolean) => void) => {
      handlers.onThinking = cb;
    },
    onGatekeeperDown: (cb: () => void) => {
      handlers.onGatekeeperDown = cb;
    },
    onReply: (cb: (r: string) => void) => {
      handlers.onReply = cb;
    },
  };

  vi.resetModules();
  await import("../src/renderer/overlay/main.ts");
  return { handlers, submitOverride, sendMessage, requestSleep };
}

function submitForm(id: string): void {
  const form = document.getElementById(id) as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

describe("overlay renderer — override is not gated on gatekeeper health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("override submit reaches btl.submitOverride even when the gatekeeper is down", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!();

    (document.getElementById("override-text") as HTMLInputElement).value = DEFAULTS.overridePhrase;
    submitForm("override-form");

    expect(app.submitOverride).toHaveBeenCalledWith(DEFAULTS.overridePhrase);
  });

  it("a state render after gatekeeper-down leaves the override input usable", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!();
    app.handlers.onState!(coldState());

    expect((document.getElementById("override-text") as HTMLInputElement).disabled).toBe(false);
  });

  it("chat stays gated when the gatekeeper is down", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!();

    (document.getElementById("input-text") as HTMLInputElement).value = "please let me keep going";
    submitForm("input-form");

    expect(app.sendMessage).not.toHaveBeenCalled();
  });

  it("chat submit reaches btl.sendMessage when the gatekeeper is up (positive control)", async () => {
    const app = await loadOverlay();

    (document.getElementById("input-text") as HTMLInputElement).value = "please let me keep going";
    submitForm("input-form");

    expect(app.sendMessage).toHaveBeenCalledWith("please let me keep going");
  });
});
```

The fourth test is the positive control for test 3: it proves `submitForm` genuinely fires the submit handler, so test 3's `not.toHaveBeenCalled()` means "the gate blocked it", not "the harness never dispatched". Without it, test 3 could false-pass on a harness that never fires the handler at all.

Two reconcile points, done by reading source — not by guessing:
- **Verify `submitForm` actually fires the handlers under happy-dom.** The handlers are `addEventListener("submit", …)` with `preventDefault()` (verified: `main.ts:182` chat, `main.ts:197` override). If `dispatchEvent(new Event("submit", …))` does not invoke them (some DOM shims only fire submit from a real button/`requestSubmit`), switch `submitForm` to `(document.getElementById(id) as HTMLFormElement).requestSubmit()`. The positive-control test is the canary — if it goes red, `submitForm` isn't firing; fix the harness before trusting any red/green here.
- **`coldState()` satisfies `render()`'s `"cold"` branch (verified).** The `"cold"` branch calls `statusLine`/`coldProse` (both read only `minutesLate`), and the post-switch render code calls `overrideHint`/`graceHint` (read `overridePhrase`/`graceCapMin`/`strictness`) and `overrideFooter` (reads the optional `overrideLog`, safe when absent) — all covered by the fixture above. If a future `./copy` change reads a new field, add it to `coldState()`; do not change the assertion.

- [ ] **Step 3: Run to confirm both gating reproductions are red**

Run: `npx vitest run tests/overlay-renderer.test.ts`
Expected: the first two tests FAIL, the last two PASS.
- Test 1 fails because `main.ts:200` early-returns on `gatekeeperDown`, so `submitOverride` is never called.
- Test 2 fails because `main.ts:136-141` sets `overrideTextEl.disabled = !inputAllowed` and `inputAllowed` includes `!gatekeeperDown`, so a render after the down disables the override input.
- Test 3 passes on current code — the chat gate at `main.ts:185` is correct and must stay.
- Test 4 (positive control) passes — chat submits reach `sendMessage` when the gatekeeper is up, proving `submitForm` fires the handler.

If test 1 or 2 passes on current code, the reproduction is wrong (probably `submitForm` isn't firing the handler) — fix the harness per Step 2's reconcile note before proceeding; a fix is only proven if the test was genuinely red first.

- [ ] **Step 4: Fix the override submit handler (`src/renderer/overlay/main.ts:200`)**

The chat handler (`main.ts:185`) correctly stays gated — a down gatekeeper cannot answer chat. But override is the escape hatch and must never be gated on gatekeeper health. Change line 200 from:

```typescript
  if (!text || gatekeeperDown) return;
```

to:

```typescript
  if (!text) return;
```

Leave the chat handler at line 185 unchanged.

- [ ] **Step 5: Fix the render-path re-disable (`src/renderer/overlay/main.ts:136-141`)**

`render()` applies `inputAllowed` (which includes `!gatekeeperDown`) to the override form/input, so any state push after a down silently re-disables the escape hatch. Decouple override from `gatekeeperDown`: override is unavailable only while already in override mode. Read the current 136-141 first (the excerpt below reflects the verified content); preserve the `overrideFormEl.hidden` assignment. Replace:

```typescript
  const inputAllowed = state.mode !== "override" && !gatekeeperDown;
  inputFormEl.classList.toggle("disabled", !inputAllowed);
  inputTextEl.disabled = !inputAllowed;

  overrideFormEl.hidden = state.mode === "override";
  overrideFormEl.classList.toggle("disabled", !inputAllowed);
  overrideTextEl.disabled = !inputAllowed;
```

with:

```typescript
  const inputAllowed = state.mode !== "override" && !gatekeeperDown;
  inputFormEl.classList.toggle("disabled", !inputAllowed);
  inputTextEl.disabled = !inputAllowed;

  const overrideAllowed = state.mode !== "override";
  overrideFormEl.hidden = state.mode === "override";
  overrideFormEl.classList.toggle("disabled", !overrideAllowed);
  overrideTextEl.disabled = !overrideAllowed;
```

- [ ] **Step 6: Run to confirm green**

Run: `npx vitest run tests/overlay-renderer.test.ts`
Expected: all four PASS. Test 1 proves the `:200` fix, test 2 proves the `:136-141` fix, test 3 confirms chat is still gated, test 4 is the positive control keeping test 3 honest.

- [ ] **Step 7: Run the full suite to confirm no regression**

Run: `npm test`
Expected: all files pass, including the new happy-dom file (it runs under `npm test` with no browser download — the docblock scopes happy-dom to this one file, the rest stay node-env).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tests/overlay-renderer.test.ts src/renderer/overlay/main.ts
git commit -m "fix: override must work even when the gatekeeper is down"
```

---

### Task 4: Add the Playwright-Electron harness

Adds `@playwright/test`, a config that builds first, and a `test:e2e` script. No overlay spec yet — this task's deliverable is a runnable E2E runner proving the app launches.

**Files:**
- Modify: `package.json` (devDependency + `test:e2e` script)
- Create: `playwright.config.ts`
- Create: `tests/e2e/smoke.spec.ts` (temporary; deleted in Task 5's commit)

**Interfaces:**
- Produces: `npm run test:e2e` runs `electron-vite build` then `playwright test`.

- [ ] **Step 1: Install the dependency**

Run: `npm install --save-dev @playwright/test`

- [ ] **Step 2: Add the `test:e2e` script to `package.json`**

Add to `"scripts"` (alongside the existing `"test": "vitest run"`):

```json
"test:e2e": "electron-vite build && playwright test"
```

- [ ] **Step 3: Create `playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
});
```

- [ ] **Step 4: Create `tests/e2e/smoke.spec.ts` to prove the launcher works**

```typescript
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("app launches and opens the overlay window", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "btl-e2e-"));
  const app = await electron.launch({
    args: ["out/main/index.js", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, BEDTIME_CLAUDE_BIN: "/usr/bin/false" },
  });
  const win = await app.firstWindow();
  expect(win).toBeTruthy();
  await app.close();
});
```

- [ ] **Step 5: Run the E2E runner**

Run: `npm run test:e2e`
Expected: build succeeds, `1 passed`. If `firstWindow()` times out because the overlay is created hidden (`show: false`), switch the assertion to `await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)` and expect `>= 1` — the window exists even before it is shown.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json playwright.config.ts tests/e2e/smoke.spec.ts
git commit -m "test: add Playwright-Electron E2E harness"
```

---

### Task 5: E2E — override works when the cage is up (wiring proof, gatekeeper up)

Seeds a persisted `LOCKED` night + `dev.windowedOverlay: true`, launches, submits the override phrase, asserts the app transitions to `OVERRIDE_NIGHT`. This is the **wiring** proof L2 cannot give: it exercises the real preload → `btl:*` IPC → `Controller` round-trip. Expected green — if it is red, the failure is IPC wiring and must be fixed in source, not in the test (and not by re-touching the L2 gating fix from Task 3).

**Files:**
- Create: `tests/e2e/overlay.spec.ts`
- Delete: `tests/e2e/smoke.spec.ts` (its launch logic is now folded into `overlay.spec.ts`)

**Interfaces:**
- Consumes: the `dev.windowedOverlay` Store seam (`settings.ts`, `overlay.ts`, `index.ts`); the persisted `sm` reconstruct-to-LOCKED path; `DEFAULTS.overridePhrase`; the DOM ids/`btl` channels in `src/renderer/overlay/`.
- Produces: `seedLockedNight()`, `launch(userDataDir)`, `readPhase(app)` — reused by Task 6.

- [ ] **Step 1: Write the spec with a seeded-launch helper and the baseline test**

Store persists one JSON file per key at `<userData>/<key>.json` (`store.ts`), so seed by writing those files before launch. Confirm the exact filename layout by reading `src/main/store.ts` first; the code below assumes `<userData>/<key>.json`.

```typescript
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/main/settings";

function seedLockedNight(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), "btl-e2e-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ ...DEFAULTS, dev: { windowedOverlay: true } }),
  );
  writeFileSync(
    join(userDataDir, "sm.json"),
    JSON.stringify({ phase: "LOCKED", triggerAt: 0, escalated: false }),
  );
  return userDataDir;
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["out/main/index.js", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, BEDTIME_CLAUDE_BIN: "/usr/bin/false" },
  });
}

async function readPhase(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ app: electronApp }) => {
    const { readFileSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const sm = JSON.parse(readFileSync(j(electronApp.getPath("userData"), "sm.json"), "utf8"));
    return sm.phase as string;
  });
}

test("override works when the cage is up", async () => {
  const userDataDir = seedLockedNight();
  const app = await launch(userDataDir);
  const win = await app.firstWindow();

  await win.fill("#override-text", DEFAULTS.overridePhrase);
  await win.click("#override-send");

  await expect.poll(() => readPhase(app)).toBe("OVERRIDE_NIGHT");
  await app.close();
});
```

- [ ] **Step 2: Confirm the selectors against the real DOM**

Verified in `src/renderer/overlay/index.html`: the override input is `#override-text` and its submit button is `#override-send` (a `<button type="submit">Pass</button>` inside `#override-form`), so `win.click("#override-send")` submits the form. The chat input is `#input-text`, its form `#input-form`, and the gatekeeper-down banner is `#gatekeeper-down`. If any id has since changed, re-read `index.html` and update the selector — do not change the assertion.

- [ ] **Step 3: Delete the smoke spec and run**

```bash
git rm tests/e2e/smoke.spec.ts
```
Run: `npm run test:e2e`
Expected: `override works when the cage is up` PASS. If it is red, triage: a stuck `LOCKED` means the override never reached the Controller — fix the IPC/preload wiring in source, not the test.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/overlay.spec.ts
git commit -m "test(e2e): override works when the cage is up"
```

---

### Task 6: E2E — override works end-to-end even when the gatekeeper is down (wiring proof)

The full-stack counterpart to Task 3. Task 3 proved the renderer *calls* `submitOverride` with the gatekeeper down; this proves that call *reaches* `OVERRIDE_NIGHT` through the real preload → IPC → Controller path — the wiring the L2 stub cannot exercise. Two distinct failure modes, two layers.

**Expected green, not red.** The gating fix landed in Task 3, so the renderer no longer swallows the submit. This step therefore does **not** follow a red-first ritual — a green here confirms the wiring was already sound. If it is **red**, the fault is in the **wiring** (preload bridge / `btl:*` channel / Controller handler), not the gating: fix the wiring in source; do **not** re-touch the Task 3 gating fix.

**Files:**
- Modify: `tests/e2e/overlay.spec.ts` (add the second test)

**Interfaces:**
- Consumes: `seedLockedNight`, `launch`, `readPhase` from Task 5; the chat input id / `btl.sendMessage` channel; the `#gatekeeper-down` element.

- [ ] **Step 1: Add the test to `tests/e2e/overlay.spec.ts`**

```typescript
test("override works even when the gatekeeper is down", async () => {
  const userDataDir = seedLockedNight();
  const app = await launch(userDataDir);
  const win = await app.firstWindow();

  // Drive the renderer into gatekeeper-down via a failed chat round-trip.
  await win.fill("#input-text", "please let me keep going");
  await win.press("#input-text", "Enter");
  await expect(win.locator("#gatekeeper-down")).toBeVisible();

  // Override must still round-trip to the Controller with the gatekeeper down.
  await win.fill("#override-text", DEFAULTS.overridePhrase);
  await win.click("#override-send");

  await expect.poll(() => readPhase(app)).toBe("OVERRIDE_NIGHT");
  await app.close();
});
```

Selectors are verified in `index.html` (see Task 5 Step 2): `#input-text`, `#gatekeeper-down`, `#override-text`, `#override-send`. If any has since changed, re-read `index.html` and update it — do not change the assertion.

- [ ] **Step 2: Run to confirm green end-to-end**

Run: `npm run test:e2e`
Expected: both E2E tests PASS. The override round-trips to `OVERRIDE_NIGHT` with the gatekeeper down, proving the wiring. If this one is red while Task 3's DOM tests are green, you have isolated a genuine *wiring* bug (not gating) — triage the preload/IPC/Controller path.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/overlay.spec.ts
git commit -m "test(e2e): override round-trips to OVERRIDE_NIGHT when the gatekeeper is down"
```

---

### Task 7: GitHub Actions CI — run all three layers on every push/PR

Runs the whole matrix in CI: L1 + L2 unit tests on `ubuntu-latest` (the happy-dom file runs here — no browser needed), L3 Electron E2E on `macos-latest`. Last task because it depends on `test:e2e` (Task 4) and the specs (Tasks 5-6) existing and passing.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `test` script (`vitest run`, pre-existing — now also runs the happy-dom L2 file) and the `test:e2e` script (`electron-vite build && playwright test`, from Task 4).

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test

  e2e:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run test:e2e
```

The E2E spec sets `BEDTIME_CLAUDE_BIN=/usr/bin/false` in each `electron.launch({ env })` call (Task 5), so the gatekeeper is deterministically unreachable without a job-level env var. Do not add a `playwright install` step — `_electron.launch` uses the project's own `electron` binary, not downloaded browsers.

- [ ] **Step 2: Validate the workflow locally and confirm all scripts run green on this machine**

Run: `npm test && npm run test:e2e`
Expected: both green locally (this is the same command pair CI runs; a green here is the strongest pre-push signal).

If you have `act` installed, optionally dry-run the unit job: `act -j unit -n`. Not required — the workflow's real proof is the first push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run unit+DOM (ubuntu) and Electron E2E (macos) suites on push/PR"
```

- [ ] **Step 4: Push and confirm both jobs pass on the PR**

After pushing, open the PR's Checks tab and confirm both `unit` and `e2e` jobs are green. If `e2e` hangs at `firstWindow()`, apply the Task 4 Step 5 fallback (`app.evaluate` on `BrowserWindow.getAllWindows().length`); if the app fails to boot on the runner, capture the launch stderr via `electron.launch({ ..., stdout: "pipe", stderr: "pipe" })` and triage from the CI log rather than retrying blindly.

---

## Self-Review

- **Three layers, non-duplicative, each proving what the others can't.** L1 (Tasks 1-2) owns clock-driven logic no launched app can reach. L2 (Task 3) owns renderer *gating* — reproduced and fixed red-green in-process. L3 (Tasks 4-6) owns *wiring* — the real preload → IPC → Controller round-trip. This is exactly the "cover the whole app across every layer with minimal duplication" the user asked for, and L2-vs-L3 is what disambiguates the user's own open question ("renderer gating or IPC wiring?").
- **The live fix is red-green proven at L2, not deferred to E2E.** Deliberate deviation from the spec's literal script (which put the reproduction in E2E): the DOM layer proves *both* `main.ts:200` **and** `main.ts:136-141` (Task 3 tests 1 and 2), including the render-disable path E2E structurally cannot drive (`GatekeeperUnreachable` at `controller.ts:457-465` calls only `pushGatekeeperDown()`, never `pushCurrentState()`, so `render()` never re-runs after a down in a launched app). Both source edits are now genuine red-before/green-after fixes, not defense-in-depth. Surface this deviation to the user at handoff.
- **E2E owns wiring, honestly labeled as expected-green.** Task 6 is not a demoted duplicate — it exclusively proves the round-trip reaches `OVERRIDE_NIGHT`, which the stubbed-`btl` L2 cannot. Because Task 3 already fixed gating, Task 6 is expected green from the start; the plan says so and defines a red there as a *wiring* defect (fix wiring, not gating) rather than faking a red-first ritual.
- **CI coverage.** All three layers run in GitHub Actions → Task 7 (L1+L2 on ubuntu via `npm test`, L3 on macOS via `npm run test:e2e`). The happy-dom file needs no browser download, so it rides the pure-node ubuntu job.
- **Global env constraint corrected.** Earlier draft forbade any DOM env. Now: node-env stays global, one file opts into happy-dom via docblock. Justified because the DOM layer *complements* (not replaces) E2E — it proves gating faster and reaches the render-disable path E2E can't.
- **Placeholder scan.** No TBD/"handle edge cases"/"similar to Task N"; every code step shows real code. Selector/method-name and `submitForm`-dispatch reconciliation steps are explicit (read real ids / verify which submit call fires) rather than guessed, because the exact happy-dom submit-dispatch behavior and a few Controller method names were not verified at plan-time.
- **Type consistency.** `FakeOverlay.shown`/`hidden`/`states`/`last()`, `FakeLock.locked`, `makeDeps(now, dir)`, `persistNoEscalationSettings(store)` match Task 1's exports and Task 2's consumers. `OverlayState` fields in Task 3's `coldState()` match `overlay-ipc.ts`. `seedLockedNight`/`launch`/`readPhase` defined in Task 5, reused in Task 6.

## Verification

- `npm test` green (L1 + L2, including the happy-dom renderer file) and `npm run test:e2e` green (L3).
- Both CI jobs (`unit` on ubuntu, `e2e` on macOS) green on the PR (Task 7).
- Task 3 tests 1 (`main.ts:200`) and 2 (`main.ts:136-141`) were **red before** the Step 4-5 source fixes and **green after** — both fixes are genuinely proven at the renderer-DOM layer; test 3 confirms chat stays gated and test 4 (positive control) keeps that negative honest.
- Task 6's end-to-end override-when-gatekeeper-down test is green, proving the fixed gating also round-trips through the real preload → IPC path to `OVERRIDE_NIGHT`. A red there would be a *wiring* defect, isolated from the (green) L2 gating tests.
- The fix is proven in-process (L2) and confirmed full-stack (L3), so no separate manual sanity-run is required — a quick `/run` at the end is still worthwhile.
