import { contextBridge, ipcRenderer } from "electron";
import type { PartialSettings, Settings } from "../main/settings";

export interface BtlSettingsApi {
  getSettings(): Promise<Settings>;
  saveSettings(settings: PartialSettings): Promise<Settings>;
  snoozedUntilMs(): Promise<number | null>;
  resetSnooze(): Promise<number | null>;
}

const api: BtlSettingsApi = {
  getSettings: () => ipcRenderer.invoke("btl-settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("btl-settings:save", settings),
  snoozedUntilMs: () => ipcRenderer.invoke("btl-settings:snoozed-until"),
  resetSnooze: () => ipcRenderer.invoke("btl-settings:reset-snooze"),
};

contextBridge.exposeInMainWorld("btlSettings", api);
