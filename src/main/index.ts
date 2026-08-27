import { app, type BrowserWindow, type Tray } from "electron";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { SystemClock } from "./clock";
import { ElectronPowerMonitor, MacScreenLock } from "./power";
import { ElectronNotifier } from "./notifications";
import { ClaudeCliGatekeeper } from "./gatekeeper";
import { Store } from "./store";
import { EventLog } from "./eventlog";
import { mergeSettings } from "./settings";
import { Controller, type OverlayHandle } from "./controller";
import {
  createOverlayWindow,
  hideOverlayWindow,
  pushGatekeeperDown,
  pushOverlayState,
  pushThinking,
  registerOverlayIpc,
  showOverlayWindow,
  type OverlayState,
} from "./overlay";
import { createTray } from "./tray";

// Electron drops a Tray's icon once it's garbage-collected, so the instance
// must outlive the app.whenReady() callback that creates it. Never read
// again after assignment — its only job is to keep the reference alive.
let _tray: Tray | null = null;

// A login-item tray app with no dock icon is easy to relaunch (IDE restart,
// `npm run dev` re-run, double-clicking the .app again) without noticing an
// existing instance is already running. Without this lock, every relaunch
// leaves a zombie process behind — all racing to read/write the same Store
// files and each with its own tray icon and overlay window.
function makeOverlayHandle(win: BrowserWindow): OverlayHandle {
  return {
    show: () => showOverlayWindow(win),
    hide: () => hideOverlayWindow(win),
    pushState: (state: OverlayState) => pushOverlayState(win, state),
    pushGatekeeperDown: (kind) => pushGatekeeperDown(win, kind),
    pushThinking: (thinking: boolean) => pushThinking(win, thinking),
  };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    app.setLoginItemSettings({ openAtLogin: true });

    const store = new Store(app.getPath("userData"));
    const eventLog = new EventLog(store);

    // A packaged GUI app has no visible stdout, so the OS-boundary calls (the
    // gatekeeper spawn, the screen-lock keystroke) that fail differently here
    // than under `npm run dev` — a login-launched app inherits a minimal PATH,
    // a different environment, and different permissions — are otherwise a
    // black box. Append their diagnostics to a file the user can read.
    const debugLogPath = join(app.getPath("userData"), "gatekeeper-debug.log");
    const debugLog = (line: string): void => {
      try {
        appendFileSync(debugLogPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Diagnostics must never take down the app.
      }
    };

    const windowedOverlay = mergeSettings(store.read("settings", {})).dev.windowedOverlay;
    const win = createOverlayWindow(undefined, windowedOverlay);
    const lock = new MacScreenLock(debugLog);

    const controller = new Controller({
      clock: new SystemClock(),
      power: new ElectronPowerMonitor(),
      lock,
      notifier: new ElectronNotifier(),
      gatekeeper: new ClaudeCliGatekeeper({ debugLog }),
      store,
      eventLog,
      overlay: makeOverlayHandle(win),
      debugLog,
    });

    registerOverlayIpc(win, controller.ipcHandlers);
    controller.start();

    _tray = createTray(controller, lock, store);

    // The overlay window is intentionally `closable: false` and runs in kiosk
    // fullscreen, both of which stall `app.quit()`'s graceful window-close —
    // leaving "Quit" (and Cmd+Q) with no effect. Force it: stop the controller's
    // timers and destroy the window (which bypasses `closable`) so the quit can
    // complete. Store writes are synchronous, so nothing is lost.
    app.on("before-quit", () => {
      controller.stop();
      if (!win.isDestroyed()) {
        win.destroy();
      }
    });
  });

  app.on("window-all-closed", () => {});
}
