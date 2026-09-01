import { describe, it, expect } from "vitest";
import { DEFAULTS, mergeSettings } from "../src/main/settings";

describe("settings", () => {
  it("fills missing fields from defaults", () => {
    const s = mergeSettings({ lockoutTime: "22:45" });
    expect(s.lockoutTime).toBe("22:45");
    expect(s.quickWakeWindowMs).toBe(DEFAULTS.quickWakeWindowMs);
    expect(s.graceCapsMs.Firm).toBe(15 * 60_000);
  });

  it("rejects an invalid lockoutTime by falling back to default", () => {
    expect(mergeSettings({ lockoutTime: "99:99" }).lockoutTime).toBe(DEFAULTS.lockoutTime);
  });

  it("returns DEFAULTS unchanged when given an empty partial", () => {
    expect(mergeSettings({})).toEqual(DEFAULTS);
  });

  it("rejects a malformed wakeTime string", () => {
    expect(mergeSettings({ wakeTime: "not-a-time" }).wakeTime).toBe(DEFAULTS.wakeTime);
  });

  it("rejects a non-positive duration and falls back to default", () => {
    expect(mergeSettings({ quickWakeWindowMs: -5 }).quickWakeWindowMs).toBe(
      DEFAULTS.quickWakeWindowMs,
    );
    expect(mergeSettings({ quickWakeWindowMs: 0 }).quickWakeWindowMs).toBe(
      DEFAULTS.quickWakeWindowMs,
    );
  });

  it("deep-merges a partial graceCapsMs object without dropping sibling fields", () => {
    const s = mergeSettings({ graceCapsMs: { Firm: 1_000 } });
    expect(s.graceCapsMs.Firm).toBe(1_000);
    expect(s.graceCapsMs.Gentle).toBe(DEFAULTS.graceCapsMs.Gentle);
    expect(s.graceCapsMs.Unmovable).toBe(DEFAULTS.graceCapsMs.Unmovable);
  });

  it("rejects a non-positive nested duration and falls back to default", () => {
    expect(mergeSettings({ graceCapsMs: { Firm: -1 } }).graceCapsMs.Firm).toBe(
      DEFAULTS.graceCapsMs.Firm,
    );
  });

  it("defaults dev.windowedOverlay to false when dev is absent", () => {
    expect(mergeSettings({}).dev.windowedOverlay).toBe(false);
  });

  it("accepts dev.windowedOverlay: true", () => {
    expect(mergeSettings({ dev: { windowedOverlay: true } }).dev.windowedOverlay).toBe(true);
  });

  it("rejects a non-boolean dev.windowedOverlay and falls back to default", () => {
    expect(
      mergeSettings({ dev: { windowedOverlay: "yes" as unknown as boolean } }).dev.windowedOverlay,
    ).toBe(false);
  });

  it("exposes the documented DEFAULTS values", () => {
    expect(DEFAULTS.schemaVersion).toBe(1);
    expect(DEFAULTS.lockoutTime).toBe("23:30");
    expect(DEFAULTS.wakeTime).toBe("07:00");
    expect(DEFAULTS.theme).toBe("drift");
    expect(DEFAULTS.countdownLeadsMin).toEqual([60, 15, 5]);
    expect(DEFAULTS.overridePhrase).toBe("let me finish tonight");
    expect(DEFAULTS.strictness).toBe("Firm");
    expect(DEFAULTS.gatekeeperModel).toBe("sonnet");
    expect(DEFAULTS.relockPolicy).toBe("wakeTime");
    expect(DEFAULTS.quickWakeWindowMs).toBe(3_600_000);
    expect(DEFAULTS.graceCapsMs).toEqual({
      Gentle: 45 * 60_000,
      Firm: 15 * 60_000,
      Unmovable: 5 * 60_000,
    });
    expect(DEFAULTS.dev).toEqual({ windowedOverlay: false });
  });
});
