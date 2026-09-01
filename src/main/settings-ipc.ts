import { ipcMain, type BrowserWindow } from "electron";
import { mergeSettings, type PartialSettings, type Settings } from "./settings";
import type { Store } from "./store";

const SETTINGS_KEY = "settings";

export interface SettingsIpcHandlers {
  onSettingsChanged(): void;
  /** Epoch ms the override night re-arms at, or null when nothing is snoozed. */
  snoozedUntilMs(): number | null;
  onResetSnooze(): void;
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

  ipcMain.handle("btl-settings:snoozed-until", (): number | null => handlers.snoozedUntilMs());

  ipcMain.handle("btl-settings:reset-snooze", (): number | null => {
    handlers.onResetSnooze();
    return handlers.snoozedUntilMs();
  });

  win.on("closed", () => {
    ipcMain.removeHandler("btl-settings:get");
    ipcMain.removeHandler("btl-settings:save");
    ipcMain.removeHandler("btl-settings:snoozed-until");
    ipcMain.removeHandler("btl-settings:reset-snooze");
  });
}
