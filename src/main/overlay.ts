import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { registerOverlayIpc, type OverlayIpcHandlers } from "./overlay-ipc";

/**
 * Tracks, per overlay window, whether the renderer has painted its first
 * frame (`ready`) and whether the Controller currently wants it on screen
 * (`wantShown`). `applyVisibility` only touches the real window once `ready`,
 * so a show() requested before first paint isn't lost.
 */
const overlayState = new WeakMap<
  BrowserWindow,
  { ready: boolean; wantShown: boolean; windowed: boolean }
>();

/**
 * Covers the screen with `setSimpleFullScreen` rather than kiosk/native
 * fullscreen deliberately: kiosk puts the window in its own macOS Space behind
 * an async slide transition, and every ordering of "leave kiosk" vs. "hide"
 * races that transition — leaving a black empty Space, or a window that stays
 * visible and follows the user across desktops. Simple-fullscreen just resizes
 * the window to fill the display (the menu bar and dock are already covered by
 * the `screen-saver` always-on-top level), with no Space and no animation, so
 * `hide()` is an ordinary synchronous hide. The trade-off vs. kiosk is that
 * system shortcuts like Cmd-Tab aren't hard-blocked — acceptable for a lockout
 * that already ships an escape hatch (the override phrase); it's friction, not
 * a tamper-proof cage.
 */
function applyVisibility(win: BrowserWindow): void {
  const state = overlayState.get(win);
  if (!state || !state.ready) {
    return;
  }
  if (state.wantShown) {
    if (!state.windowed && !win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(true);
    }
    win.show();
    win.focus();
  } else {
    win.hide();
    if (!state.windowed && win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(false);
    }
  }
}

export function showOverlayWindow(win: BrowserWindow): void {
  const state = overlayState.get(win);
  if (state) {
    state.wantShown = true;
  }
  applyVisibility(win);
}

export function hideOverlayWindow(win: BrowserWindow): void {
  const state = overlayState.get(win);
  if (state) {
    state.wantShown = false;
  }
  applyVisibility(win);
}

/**
 * Creates the overlay window. `ipcHandlers`, if supplied, wires up the
 * `window.btl` bridge immediately (Task 14's Controller passes its real
 * handlers here); omitting it leaves IPC unregistered, matching Task 1's
 * original zero-arg call site until the Controller exists to supply them.
 *
 * `windowed` renders a normal, closable, non-topmost window instead of the
 * undismissable fullscreen cage — a dev-only escape hatch for iterating on
 * the overlay's show/hide logic without risking getting locked out by a bug
 * in that same logic.
 */
export function createOverlayWindow(
  ipcHandlers?: OverlayIpcHandlers,
  windowed = false,
): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...(windowed ? { width: 1000, height: 800 } : display.bounds),
    show: false,
    frame: windowed,
    alwaysOnTop: !windowed,
    skipTaskbar: !windowed,
    resizable: windowed,
    movable: windowed,
    minimizable: windowed,
    closable: windowed,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayState.set(win, { ready: false, wantShown: false, windowed });
  if (!windowed) {
    win.setAlwaysOnTop(true, "screen-saver"); // above the menu bar
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.once("ready-to-show", () => {
    const state = overlayState.get(win);
    if (state) {
      state.ready = true;
    }
    applyVisibility(win);
  });
  win.loadFile(join(__dirname, "../renderer/overlay/index.html"));
  if (ipcHandlers) {
    registerOverlayIpc(win, ipcHandlers);
  }
  return win;
}

export {
  registerOverlayIpc,
  pushOverlayState,
  pushGatekeeperDown,
  pushThinking,
  type OverlayState,
  type OverlayMode,
  type OverlayIpcHandlers,
} from "./overlay-ipc";
