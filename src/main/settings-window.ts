import { BrowserWindow } from "electron";
import { join } from "node:path";
import { registerSettingsIpc, type SettingsIpcHandlers } from "./settings-ipc";
import type { Store } from "./store";

let win: BrowserWindow | null = null;

/**
 * Opens the settings window, creating it lazily on first call and focusing
 * the existing instance on subsequent calls rather than creating duplicates
 * (mirrors the tray's single "Open settings…" entry point).
 */
export function openSettingsWindow(store: Store, handlers: SettingsIpcHandlers): BrowserWindow {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 560,
    height: 680,
    resizable: false,
    title: "Bedtime Lockout — Settings",
    webPreferences: {
      preload: join(__dirname, "../preload/settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, "../renderer/settings/index.html"));
  registerSettingsIpc(win, store, handlers);
  win.on("closed", () => {
    win = null;
  });
  return win;
}
