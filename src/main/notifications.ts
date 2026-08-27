import { Notification } from "electron";
import type { NotificationPort } from "./ports";

/**
 * Countdown notifications are strictly informational: no actions, no
 * close-button override, nothing a user could mistake for a way to delay
 * or cancel the lockout. `Notification.isSupported()` is checked because
 * Electron's own docs note it can be false depending on platform/signing
 * state — logging and no-oping here is safer than letting construction
 * fail in a way that could interrupt the countdown flow calling it.
 */
export class ElectronNotifier implements NotificationPort {
  notify(title: string, body: string): void {
    if (!Notification.isSupported()) {
      console.error("ElectronNotifier: notifications not supported, skipping", { title });
      return;
    }
    new Notification({ title, body }).show();
  }
}
