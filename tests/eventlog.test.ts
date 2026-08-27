import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { EventLog } from "../src/main/eventlog";

function makeLog(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "btl-eventlog-"));
  return new EventLog(new Store(dir));
}

describe("EventLog.summaryForGatekeeper — overridesThisWeek", () => {
  it("counts 3 overrides this week and excludes gatekeeper_unreachable events", () => {
    const log = makeLog();
    const now = new Date("2026-06-30T12:00:00.000Z");

    log.append({ v: 1, kind: "override", at: "2026-06-28T10:00:00.000Z" });
    log.append({ v: 1, kind: "override", at: "2026-06-29T10:00:00.000Z" });
    log.append({ v: 1, kind: "override", at: "2026-06-30T09:00:00.000Z" });
    log.append({
      v: 1,
      kind: "gatekeeper_unreachable",
      at: "2026-06-30T10:00:00.000Z",
      reason: "timeout",
    });

    const summary = log.summaryForGatekeeper(now);

    expect(summary.overridesThisWeek).toBe(3);
  });

  it('does not count an unlock with method "override" as an override event', () => {
    const log = makeLog();
    const now = new Date("2026-06-30T12:00:00.000Z");

    log.append({ v: 1, kind: "unlock", at: "2026-06-30T09:00:00.000Z", method: "override" });

    expect(log.summaryForGatekeeper(now).overridesThisWeek).toBe(0);
  });

  it("excludes overrides older than the rolling 7-day window", () => {
    const log = makeLog();
    const now = new Date("2026-06-30T12:00:00.000Z");
    const windowStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;

    // exactly at the lower boundary: included
    log.append({ v: 1, kind: "override", at: new Date(windowStartMs).toISOString() });
    // 1ms before the lower boundary: excluded
    log.append({ v: 1, kind: "override", at: new Date(windowStartMs - 1).toISOString() });

    expect(log.summaryForGatekeeper(now).overridesThisWeek).toBe(1);
  });

  it("reports overridesThisWeek === 0 on an empty log", () => {
    const log = makeLog();
    const summary = log.summaryForGatekeeper(new Date("2026-06-30T12:00:00.000Z"));
    expect(summary.overridesThisWeek).toBe(0);
  });
});

describe("EventLog.summaryForGatekeeper — lastLockoutAt", () => {
  it("returns null when no lockout events have been recorded", () => {
    const log = makeLog();
    const summary = log.summaryForGatekeeper(new Date("2026-06-30T12:00:00.000Z"));
    expect(summary.lastLockoutAt).toBeNull();
  });

  it("returns the actualAt of the most recent lockout, regardless of the 7-day window", () => {
    const log = makeLog();
    const now = new Date("2026-06-30T12:00:00.000Z");

    log.append({
      v: 1,
      kind: "lockout",
      scheduledAt: "2026-06-01T23:30:00.000Z",
      actualAt: "2026-06-01T23:31:00.000Z",
      escalated: false,
    });
    log.append({
      v: 1,
      kind: "lockout",
      scheduledAt: "2026-06-29T23:30:00.000Z",
      actualAt: "2026-06-29T23:32:00.000Z",
      escalated: true,
    });

    expect(log.summaryForGatekeeper(now).lastLockoutAt).toBe("2026-06-29T23:32:00.000Z");
  });
});

describe("EventLog.summaryForGatekeeper — quickWakesThisWeek", () => {
  it("counts quickwake events within the rolling 7-day window", () => {
    const log = makeLog();
    const now = new Date("2026-06-30T12:00:00.000Z");

    log.append({ v: 1, kind: "quickwake", at: "2026-06-29T06:00:00.000Z", sleptMs: 1_200_000 });
    log.append({ v: 1, kind: "quickwake", at: "2026-06-30T06:00:00.000Z", sleptMs: 900_000 });
    // outside the window
    log.append({ v: 1, kind: "quickwake", at: "2026-06-01T06:00:00.000Z", sleptMs: 600_000 });

    expect(log.summaryForGatekeeper(now).quickWakesThisWeek).toBe(2);
  });

  it("reports quickWakesThisWeek === 0 on an empty log", () => {
    const log = makeLog();
    const summary = log.summaryForGatekeeper(new Date("2026-06-30T12:00:00.000Z"));
    expect(summary.quickWakesThisWeek).toBe(0);
  });
});

describe("EventLog.append", () => {
  it("persists events through Store so a new EventLog instance over the same dir sees them", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-eventlog-"));
    const store1 = new Store(dir);
    const log1 = new EventLog(store1);
    log1.append({ v: 1, kind: "override", at: "2026-06-30T09:00:00.000Z" });

    const log2 = new EventLog(new Store(dir));
    expect(log2.recent(0)).toHaveLength(1);
  });

  it("preserves the optional meta bag verbatim (#11 open schema)", () => {
    const log = makeLog();
    log.append({
      v: 1,
      kind: "override",
      at: "2026-06-30T09:00:00.000Z",
      meta: { source: "wearable", heartRate: 72 },
    });

    expect(log.recent(0)[0]).toMatchObject({ meta: { source: "wearable", heartRate: 72 } });
  });
});

describe("EventLog.recent", () => {
  it("returns an empty array for an empty log", () => {
    const log = makeLog();
    expect(log.recent(0)).toEqual([]);
  });

  it("returns only events with timestamp >= the given absolute epoch ms, inclusive", () => {
    const log = makeLog();
    const cutoff = new Date("2026-06-30T00:00:00.000Z").getTime();

    log.append({ v: 1, kind: "override", at: "2026-06-29T23:59:59.999Z" }); // excluded
    log.append({ v: 1, kind: "override", at: "2026-06-30T00:00:00.000Z" }); // included (boundary)
    log.append({ v: 1, kind: "override", at: "2026-06-30T00:00:01.000Z" }); // included

    const result = log.recent(cutoff);
    expect(result).toHaveLength(2);
    expect(result.map((e) => (e.kind === "override" ? e.at : null))).toEqual([
      "2026-06-30T00:00:00.000Z",
      "2026-06-30T00:00:01.000Z",
    ]);
  });

  it("uses actualAt (not scheduledAt) as the timestamp for lockout events", () => {
    const log = makeLog();
    log.append({
      v: 1,
      kind: "lockout",
      scheduledAt: "2026-06-29T23:30:00.000Z",
      actualAt: "2026-06-30T00:05:00.000Z",
      escalated: false,
    });

    const cutoff = new Date("2026-06-30T00:00:00.000Z").getTime();
    expect(log.recent(cutoff)).toHaveLength(1);

    const laterCutoff = new Date("2026-06-30T00:10:00.000Z").getTime();
    expect(log.recent(laterCutoff)).toHaveLength(0);
  });

  it("returns all six LockoutEvent variants without throwing", () => {
    const log = makeLog();
    log.append({
      v: 1,
      kind: "lockout",
      scheduledAt: "2026-06-30T23:30:00.000Z",
      actualAt: "2026-06-30T23:30:05.000Z",
      escalated: false,
    });
    log.append({
      v: 1,
      kind: "unlock",
      at: "2026-06-30T23:35:00.000Z",
      method: "negotiated",
      turns: 3,
    });
    log.append({ v: 1, kind: "override", at: "2026-06-30T23:36:00.000Z" });
    log.append({ v: 1, kind: "quickwake", at: "2026-06-30T23:37:00.000Z", sleptMs: 500 });
    log.append({ v: 1, kind: "relock", at: "2026-06-30T23:38:00.000Z", reason: "quickwake" });
    log.append({
      v: 1,
      kind: "gatekeeper_unreachable",
      at: "2026-06-30T23:39:00.000Z",
      reason: "network",
    });

    expect(log.recent(0)).toHaveLength(6);
  });
});
