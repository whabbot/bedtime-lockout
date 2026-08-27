import { Store } from "../../src/main/store";
import { EventLog } from "../../src/main/eventlog";
import { GatekeeperUnreachable } from "../../src/main/gatekeeper";
import { DEFAULTS } from "../../src/main/settings";
import type { OverlayHandle, ControllerDeps } from "../../src/main/controller";
import type { OverlayState } from "../../src/main/overlay-ipc";
import type {
  ClockPort,
  GatekeeperPort,
  LockPort,
  NotificationPort,
  PowerMonitorPort,
} from "../../src/main/ports";

export class FakeClock implements ClockPort {
  constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export class FakePower implements PowerMonitorPort {
  resumeCb: (() => void) | null = null;
  unlockCb: (() => void) | null = null;
  idleSeconds = 0;
  onResume(cb: () => void): void {
    this.resumeCb = cb;
  }
  onSuspend(): void {}
  onUnlock(cb: () => void): void {
    this.unlockCb = cb;
  }
  getSystemIdleTime(): number {
    return this.idleSeconds;
  }
}

export class FakeLock implements LockPort {
  locked = 0;
  lockNow(): void {
    this.locked += 1;
  }
}

export class FakeNotifier implements NotificationPort {
  notes: { title: string; body: string }[] = [];
  notify(title: string, body: string): void {
    this.notes.push({ title, body });
  }
}

export class FakeGatekeeper implements GatekeeperPort {
  replies: string[] = [];
  throwUnreachable = false;
  calls: { systemPrompt: string; transcript: string; userMsg: string }[] = [];
  async ask(systemPrompt: string, transcript: string, userMsg: string): Promise<string> {
    this.calls.push({ systemPrompt, transcript, userMsg });
    if (this.throwUnreachable) {
      throw new GatekeeperUnreachable("test-unreachable");
    }
    return this.replies.shift() ?? "…\n<<GRANT:0>>";
  }
}

export class FakeOverlay implements OverlayHandle {
  shown = 0;
  hidden = 0;
  states: OverlayState[] = [];
  gatekeeperDown = 0;
  thinking: boolean[] = [];
  show(): void {
    this.shown += 1;
  }
  hide(): void {
    this.hidden += 1;
  }
  pushState(state: OverlayState): void {
    this.states.push(state);
  }
  pushGatekeeperDown(): void {
    this.gatekeeperDown += 1;
  }
  pushThinking(thinking: boolean): void {
    this.thinking.push(thinking);
  }
  last(): OverlayState | undefined {
    return this.states[this.states.length - 1];
  }
}

export function makeDeps(now: number, dir: string): ControllerDeps {
  const store = new Store(dir);
  return {
    clock: new FakeClock(now),
    power: new FakePower(),
    lock: new FakeLock(),
    notifier: new FakeNotifier(),
    gatekeeper: new FakeGatekeeper(),
    store,
    eventLog: new EventLog(store),
    overlay: new FakeOverlay(),
  };
}

export function persistNoEscalationSettings(store: Store): void {
  store.write("settings", {
    ...DEFAULTS,
    escalation: { ...DEFAULTS.escalation, enabled: false },
  });
}
