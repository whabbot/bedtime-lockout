import type { ClockPort } from "./ports";
import type { Store } from "./store";

const POLL_INTERVAL_MS = 15_000;
const TIMERS_KEY = "timers";

interface PersistedTarget {
  id: string;
  at: number;
}

interface Target {
  at: number;
  callback?: () => void;
}

/**
 * Fires callbacks at absolute epoch-ms targets, re-checked on a poll rather
 * than via a single `setTimeout` — Node/Electron timers don't reliably fire
 * on schedule across a system sleep, so the only safe design is to compare
 * against wall-clock time repeatedly (see `checkNow`).
 *
 * Targets are persisted as plain `{id, at}` pairs (callbacks aren't
 * serializable). On construction, any targets already in the Store are
 * loaded without callbacks, so `pending()` can report them and a caller can
 * re-`schedule()` the same id to re-attach a callback after a restart.
 */
export class WallClockTimer {
  private readonly store: Store;
  private readonly clock: ClockPort;
  private readonly targets = new Map<string, Target>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, clock: ClockPort) {
    this.store = store;
    this.clock = clock;
    for (const { id, at } of this.store.read<PersistedTarget[]>(TIMERS_KEY, [])) {
      this.targets.set(id, { at });
    }
  }

  schedule(id: string, at: number, callback: () => void): void {
    this.targets.set(id, { at, callback });
    this.persist();
  }

  /**
   * Cancels a scheduled target by id, if present. Needed when escalation
   * recomputes countdown firings via `recompress` into fewer targets than
   * were originally scheduled — the stale higher-numbered ids must be
   * cancelled so they don't fire a "bedtime soon" warning after the lock is
   * already active.
   */
  unschedule(id: string): void {
    if (this.targets.delete(id)) {
      this.persist();
    }
  }

  checkNow(): void {
    const nowMs = this.clock.now().getTime();
    const due = [...this.targets.entries()].filter(([, target]) => target.at <= nowMs);

    let changed = false;
    for (const [id, target] of due) {
      // An earlier due entry's callback, processed earlier in this same
      // batch, may have already re-armed (or cancelled) this id — e.g. a
      // day-rollover firing before a stale nightly-trigger entry in the same
      // poll. Firing the stale snapshot would act on out-of-date state, so
      // skip anything no longer current.
      if (this.targets.get(id) !== target) {
        continue;
      }
      if (!target.callback) {
        continue;
      }
      target.callback();
      // Only remove the target the callback actually fired for — a callback
      // that calls schedule() on its own id (a recurring job re-arming
      // itself before returning) must survive this cleanup, not have its
      // fresh re-registration wiped out by this now-stale reference.
      if (this.targets.get(id) === target) {
        this.targets.delete(id);
      }
      changed = true;
    }

    if (changed) {
      this.persist();
    }
  }

  pending(): PersistedTarget[] {
    return [...this.targets.entries()].map(([id, target]) => ({ id, at: target.at }));
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = setInterval(() => this.checkNow(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private persist(): void {
    this.store.write(TIMERS_KEY, this.pending());
  }
}
