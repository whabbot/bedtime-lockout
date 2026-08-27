import { ipcMain, type BrowserWindow } from "electron";
import { mergeSettings, type PartialSettings, type Settings } from "./settings";
import type { Store } from "./store";

const SETTINGS_KEY = "settings";

export interface SettingsIpcHandlers {
  onSettingsChanged(): void;
}

/**
 * Registers the `ipcMain.handle` routes the settings preload's
 * `window.btlSettings` bridge calls into. The renderer always sends a full
 * `Settings` object (fetched via `getSettings` on load, edited in place) so a
 * save can never blow away fields the user didn't touch — `mergeSettings`
 * still re-validates every field before it's persisted, since renderer input
 * is never trusted directly.
 */
export function registerSettingsIpc(
  win: BrowserWindow,
  store: Store,
  handlers: SettingsIpcHandlers,
): void {
  ipcMain.handle(
    "btl-settings:get",
    (): Settings => mergeSettings(store.read<Record<string, unknown>>(SETTINGS_KEY, {})),
  );

  ipcMain.handle("btl-settings:save", (_e, partial: PartialSettings): Settings => {
    const merged = mergeSettings(partial);
    store.write(SETTINGS_KEY, merged);
    handlers.onSettingsChanged();
    return merged;
  });

  win.on("closed", () => {
    ipcMain.removeHandler("btl-settings:get");
    ipcMain.removeHandler("btl-settings:save");
  });
}
