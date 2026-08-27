import { contextBridge, ipcRenderer } from "electron";
import type { OverlayState } from "../main/overlay-ipc";
import type { GatekeeperFailureKind } from "../main/gatekeeper";

export interface BtlApi {
  sendMessage(text: string): Promise<{ reply: string } | { unreachable: true }>;
  submitOverride(text: string): Promise<boolean>;
  requestSleep(): void;
  onState(cb: (state: OverlayState) => void): void;
  onThinking(cb: (thinking: boolean) => void): void;
  onGatekeeperDown(cb: (kind: GatekeeperFailureKind) => void): void;
  onReply(cb: (reply: string) => void): void;
}

/**
 * `onReply` is intentionally kept distinct from `sendMessage`'s resolved
 * value rather than folded away: `sendMessage`'s Promise only ever settles
 * for the call that made it, but a future streaming/interrupt-driven
 * gatekeeper reply (or a reply arriving after the renderer reloads mid-call)
 * needs an event channel independent of any particular invoke() call. Today
 * both fire from the same round trip, so the renderer may use either; the
 * distinct channel exists so that doesn't have to stay true forever.
 */
const api: BtlApi = {
  sendMessage: (text) => ipcRenderer.invoke("btl:sendMessage", text),
  submitOverride: (text) => ipcRenderer.invoke("btl:submitOverride", text),
  requestSleep: () => {
    ipcRenderer.invoke("btl:requestSleep");
  },
  onState: (cb) => {
    ipcRenderer.on("btl:state", (_e, state: OverlayState) => cb(state));
  },
  onThinking: (cb) => {
    ipcRenderer.on("btl:thinking", (_e, thinking: boolean) => cb(thinking));
  },
  onGatekeeperDown: (cb) => {
    ipcRenderer.on("btl:gatekeeperDown", (_e, kind: GatekeeperFailureKind) => cb(kind));
  },
  onReply: (cb) => {
    ipcRenderer.on("btl:reply", (_e, reply: string) => cb(reply));
  },
};

contextBridge.exposeInMainWorld("btl", api);
