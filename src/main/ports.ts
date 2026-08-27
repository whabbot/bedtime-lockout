/**
 * ClockPort: the only sanctioned way decision logic reads wall-clock time.
 * No `Date.now()` calls inside pure logic modules — inject a ClockPort instead
 * so tests can control "now" deterministically.
 */
export interface ClockPort {
  now(): Date;
}

/**
 * GatekeeperPort: the boundary to the LLM gatekeeper backend (Task 8,
 * `ClaudeCliGatekeeper`). `ask` resolves with the gatekeeper's reply text on
 * success and MUST reject with `GatekeeperUnreachable` (see
 * `src/main/gatekeeper.ts`) for any failure mode — non-zero exit, non-JSON
 * output, `is_error: true`, or timeout — never silently return a default.
 * This is the fail-closed boundary mandated by issue #3.
 */
export interface GatekeeperPort {
  ask(
    systemPrompt: string,
    transcript: string,
    userMsg: string,
    opts?: { model?: "sonnet" | "haiku"; onDelta?: (text: string) => void },
  ): Promise<string>;
}

/**
 * PowerMonitorPort: the boundary to the OS's sleep/wake and idle-time
 * signals (Electron's `powerMonitor` singleton). `getSystemIdleTime()`
 * matches `powerMonitor.getSystemIdleTime()` exactly: seconds since the
 * last user input, across the whole system (not just this app).
 */
export interface PowerMonitorPort {
  onResume(cb: () => void): void;
  onSuspend(cb: () => void): void;
  /**
   * Fires when the screen is unlocked (the user returns from a locked screen).
   * A screen lock — unlike a real system sleep — emits no suspend/resume, so
   * this is the signal that the user has come back from a lock.
   */
  onUnlock(cb: () => void): void;
  getSystemIdleTime(): number;
}

/**
 * LockPort: the boundary for securing the machine when the user steps away.
 * Named for intent, not mechanism — the concrete implementation locks the
 * screen behind the OS login window rather than sleeping the display, so the
 * lockout can't be escaped by simply waking a merely-slept screen.
 */
export interface LockPort {
  lockNow(): void;
}

/**
 * NotificationPort: the boundary for OS-level countdown notifications.
 * Deliberately shaped with no actions/buttons — a notification here is a
 * one-way heads-up, never an interactive escape hatch from the lockout.
 */
export interface NotificationPort {
  notify(title: string, body: string): void;
}
