import { ipcMain, type BrowserWindow } from "electron";
import type { Msg } from "./gatekeeper-prompt";
import type { GatekeeperFailureKind } from "./gatekeeper";

export type OverlayMode = "cold" | "mid" | "relock" | "quickwake" | "override";

/**
 * Everything the renderer needs to paint one of the five main-driven overlay
 * modes. Pushed wholesale on every state-machine transition (Task 14) via
 * `pushOverlayState` — the renderer never derives `mode` itself (e.g. from
 * `transcript.length`), it just renders whichever mode value arrives.
 */
export interface OverlayState {
  mode: OverlayMode;
  minutesLate: number;
  strictness: "Gentle" | "Firm" | "Unmovable";
  graceCapMin: number;
  overridePhrase: string;
  transcript: Msg[];
  reentry?: {
    kind: "grace" | "quickwake";
    promisedMin?: number;
    priorCommitmentAt?: string;
    sleptAt?: string;
    wakeTime?: string;
    minutesSinceWake?: number;
  };
  overrideLog?: {
    at: string;
    countThisWeek: number;
  };
}

export interface OverlayIpcHandlers {
  onSendMessage(text: string): Promise<{ reply: string } | { unreachable: true }>;
  onSubmitOverride(text: string): Promise<boolean>;
  onRequestSleep(): void;
}

/**
 * Registers the `ipcMain.handle` routes the preload's `window.btl` bridge
 * calls into. Thin delegation only — Task 14 supplies the real `handlers`
 * (askGatekeeper, matchOverride, the state machine); this module owns no
 * business logic itself.
 */
export function registerOverlayIpc(win: BrowserWindow, handlers: OverlayIpcHandlers): void {
  ipcMain.handle("btl:sendMessage", async (_e, text: string) => {
    const result = await handlers.onSendMessage(text);
    if ("reply" in result) {
      win.webContents.send("btl:reply", result.reply);
    }
    return result;
  });
  ipcMain.handle("btl:submitOverride", (_e, text: string) => handlers.onSubmitOverride(text));
  ipcMain.handle("btl:requestSleep", () => {
    handlers.onRequestSleep();
  });
  win.on("closed", () => {
    ipcMain.removeHandler("btl:sendMessage");
    ipcMain.removeHandler("btl:submitOverride");
    ipcMain.removeHandler("btl:requestSleep");
  });
}

export function pushOverlayState(win: BrowserWindow, state: OverlayState): void {
  win.webContents.send("btl:state", state);
}

export function pushGatekeeperDown(win: BrowserWindow, kind: GatekeeperFailureKind): void {
  win.webContents.send("btl:gatekeeperDown", kind);
}

export function pushThinking(win: BrowserWindow, thinking: boolean): void {
  win.webContents.send("btl:thinking", thinking);
}
