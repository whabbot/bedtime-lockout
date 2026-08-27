import { app, Menu, nativeImage, Tray } from "electron";
import type { Controller } from "./controller";
import type { LockPort } from "./ports";
import type { Store } from "./store";
import type { SM } from "./statemachine";
import { nextTrigger } from "./scheduler";
import { formatClock } from "../renderer/overlay/copy";
import type { SettingsIpcHandlers } from "./settings-ipc";
import { openSettingsWindow } from "./settings-window";

// 16x16 transparent PNG — macOS renders the tray purely via `setTitle`'s text,
// so the icon itself only needs to exist, not carry meaningful pixels.
const EMPTY_ICON = nativeImage.createFromDataURL(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAACklEQVR4AWMAAgAABAABINitfQAAAABJRU5ErkJggg==",
);

/**
 * A human-readable status line for the current lockout phase, so the tray
 * tells the user what the app is actually doing rather than always claiming to
 * be "Armed". Recomputed each time it's rendered (menu open or phase change),
 * not a live-ticking countdown — Electron's native `Menu` has no custom-widget
 * support for that.
 */
function statusLabel(store: Store): string {
  const settings = store.read<{ lockoutTime?: string; wakeTime?: string }>("settings", {});
  const sm = store.read<SM>("sm", { phase: "IDLE" });
  const now = new Date();
  const lockoutTime = settings.lockoutTime ?? "23:30";
  const wakeTime = settings.wakeTime ?? "07:00";

  switch (sm.phase) {
    case "LOCKED":
      return "Locked";
    case "GRACE":
      return sm.relockAt !== undefined
        ? `Unlocked · re-locks at ${formatClock(new Date(sm.relockAt))}`
        : "Unlocked briefly";
    case "SLEEP_WATCH":
      return "Screen locked";
    case "OVERRIDE_NIGHT":
      // The override phrase stands the app down for the rest of the night; it
      // re-arms at the next day-rollover, which fires at wakeTime.
      return `Snoozed until ${formatClock(nextTrigger(wakeTime, now))}`;
    default:
      return `Armed · locks at ${formatClock(nextTrigger(lockoutTime, now))}`;
  }
}

/**
 * Creates the menu-bar tray icon and its native Menu. The caller must keep
 * the returned `Tray` referenced for the app's lifetime — Electron drops the
 * icon once it's garbage-collected.
 */
export function createTray(controller: Controller, lock: LockPort, store: Store): Tray {
  const tray = new Tray(EMPTY_ICON);
  tray.setTitle("☾"); // moon glyph — visible menu-bar presence for the transparent icon

  const settingsHandlers: SettingsIpcHandlers = {
    onSettingsChanged: () => controller.reloadSettings(),
  };

  const rebuildMenu = (): void => {
    const status = statusLabel(store);
    // Surface the status on hover too, so it's visible without opening the menu.
    tray.setToolTip(`Bedtime Lockout · ${status}`);
    const menu = Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: "Lock now", click: () => controller.triggerNow() },
      { label: "[dev] Lock screen now", click: () => lock.lockNow() },
      { type: "separator" },
      {
        label: "Open settings…",
        accelerator: "Cmd+,",
        click: () => openSettingsWindow(store, settingsHandlers),
      },
      { type: "separator" },
      { label: "Quit Bedtime Lockout", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  };

  // Rebuild on menu open (catches the time ticking forward) and on every phase
  // change (catches lock/override/wake), so the status is never stale.
  tray.on("click", rebuildMenu);
  controller.setStatusListener(rebuildMenu);
  rebuildMenu();

  return tray;
}
