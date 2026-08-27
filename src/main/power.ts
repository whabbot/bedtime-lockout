import { powerMonitor } from "electron";
import { spawn } from "node:child_process";
import type { PowerMonitorPort, LockPort } from "./ports";

export class ElectronPowerMonitor implements PowerMonitorPort {
  onResume(cb: () => void): void {
    powerMonitor.on("resume", cb);
  }

  onSuspend(cb: () => void): void {
    powerMonitor.on("suspend", cb);
  }

  onUnlock(cb: () => void): void {
    powerMonitor.on("unlock-screen", cb);
  }

  getSystemIdleTime(): number {
    return powerMonitor.getSystemIdleTime();
  }
}

// Sends the system "Lock Screen" shortcut (Control-Command-Q) via System
// Events. This is the modern replacement for the long-removed CGSession
// binary; it locks immediately and can't be undone by nudging the mouse. The
// catch: sending synthetic keystrokes needs the app to hold Accessibility
// permission (System Settings › Privacy & Security › Accessibility) — without
// it, osascript exits non-zero with error -1719 and nothing locks.
const LOCK_KEYSTROKE_SCRIPT =
  'tell application "System Events" to keystroke "q" using {control down, command down}';

/**
 * Locks the screen by sending Control-Command-Q. Any failure (most commonly a
 * missing Accessibility grant) is surfaced through `debugLog` rather than a
 * crash: osascript's stderr/exit code names the exact cause, and the caller
 * has already committed to locking — there's nothing to recover here.
 */
export class MacScreenLock implements LockPort {
  constructor(private readonly debugLog: (line: string) => void = () => {}) {}

  lockNow(): void {
    const child = spawn("osascript", ["-e", LOCK_KEYSTROKE_SCRIPT]);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      this.debugLog(`lock: spawn error ${err.message}`);
    });
    child.on("close", (code) => {
      this.debugLog(`lock: osascript exit=${code}${stderr ? ` stderr=${stderr.trim()}` : ""}`);
    });
  }
}
