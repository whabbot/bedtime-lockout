import type { Store } from "./store";

/**
 * Append-only event log entries (schema version 1). Every variant carries
 * `v: 1` and an optional open `meta?: object` bag so future external/wearable
 * data sources can attach arbitrary data without a schema redesign (#11).
 */
export type LockoutEvent =
  | {
      v: 1;
      kind: "lockout";
      scheduledAt: string;
      actualAt: string;
      escalated: boolean;
      meta?: object;
    }
  | {
      v: 1;
      kind: "unlock";
      at: string;
      method: "negotiated" | "override" | "sleep";
      turns?: number;
      graceMs?: number;
      meta?: object;
    }
  | { v: 1; kind: "override"; at: string; meta?: object }
  | { v: 1; kind: "quickwake"; at: string; sleptMs: number; meta?: object }
  | { v: 1; kind: "relock"; at: string; reason: "grace" | "quickwake"; meta?: object }
  | { v: 1; kind: "gatekeeper_unreachable"; at: string; reason: string; meta?: object };

/**
 * Rolling-history digest handed to the (Task 7) gatekeeper prompt builder.
 *
 * Field choices beyond the required `overridesThisWeek`:
 * - `lastLockoutAt: string | null` — ISO timestamp (`actualAt`) of the most
 *   recent `lockout` event, or `null` if none have ever been recorded.
 * - `quickWakesThisWeek: number` — count of `quickwake` events in the same
 *   rolling 7-day window as `overridesThisWeek`, for "quick-wake frequency".
 */
export interface HistorySummary {
  overridesThisWeek: number;
  lastLockoutAt: string | null;
  quickWakesThisWeek: number;
}

const EVENTS_KEY = "events";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Extracts the canonical timestamp (ms since epoch) for any LockoutEvent variant. */
function timestampMs(ev: LockoutEvent): number {
  const iso = ev.kind === "lockout" ? ev.actualAt : ev.at;
  return new Date(iso).getTime();
}

/**
 * Append-only event log, persisted via the Task 2 `Store`. All decision
 * logic here is pure with respect to time: `summaryForGatekeeper` uses only
 * the `now` passed in by the caller, and `append`/`recent` never reach for
 * wall-clock time themselves — timestamps come from the events' own
 * `at`/`actualAt`/`scheduledAt` fields, set by the caller from a ClockPort.
 */
export class EventLog {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Appends an event to the log, persisting through Store. */
  append(ev: LockoutEvent): void {
    const events = this.store.read<LockoutEvent[]>(EVENTS_KEY, []);
    events.push(ev);
    this.store.write(EVENTS_KEY, events);
  }

  /** Returns all events whose own timestamp is >= sinceMs (absolute epoch ms). */
  recent(sinceMs: number): LockoutEvent[] {
    const events = this.store.read<LockoutEvent[]>(EVENTS_KEY, []);
    return events.filter((ev) => timestampMs(ev) >= sinceMs);
  }

  /**
   * Summarizes recent history for the gatekeeper prompt builder (Task 7).
   * "This week" is a rolling 7-day window ending at `now`: [now - 7d, now],
   * not a calendar week — there's no calendar-week semantic defined anywhere
   * else in the spec, and a rolling window is simpler to reason about and
   * test than calendar-boundary logic.
   */
  summaryForGatekeeper(now: Date): HistorySummary {
    const windowStartMs = now.getTime() - SEVEN_DAYS_MS;
    const windowEndMs = now.getTime();
    const events = this.store.read<LockoutEvent[]>(EVENTS_KEY, []);

    const inWindow = events.filter((ev) => {
      const t = timestampMs(ev);
      return t >= windowStartMs && t <= windowEndMs;
    });

    const overridesThisWeek = inWindow.filter((ev) => ev.kind === "override").length;
    const quickWakesThisWeek = inWindow.filter((ev) => ev.kind === "quickwake").length;

    const lockouts = events.filter(
      (ev): ev is Extract<LockoutEvent, { kind: "lockout" }> => ev.kind === "lockout",
    );
    const lastLockoutAt =
      lockouts.length === 0
        ? null
        : lockouts.reduce((latest, ev) => (timestampMs(ev) > timestampMs(latest) ? ev : latest))
            .actualAt;

    return { overridesThisWeek, lastLockoutAt, quickWakesThisWeek };
  }
}
