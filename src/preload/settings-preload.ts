import { contextBridge, ipcRenderer } from "electron";
import type { PartialSettings, Settings } from "../main/settings";

export interface BtlSettingsApi {
  getSettings(): Promise<Settings>;
  saveSettings(settings: PartialSettings): Promise<Settings>;
}

const api: BtlSettingsApi = {
  getSettings: () => ipcRenderer.invoke("btl-settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("btl-settings:save", settings),
};

contextBridge.exposeInMainWorld("btlSettings", api);
