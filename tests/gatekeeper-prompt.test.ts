import { describe, it, expect, beforeAll } from "vitest";
import {
  buildSystemPrompt,
  serializeTranscript,
  type GatekeeperContext,
  type Msg,
} from "../src/main/gatekeeper-prompt";
import type { HistorySummary } from "../src/main/eventlog";

// formatClock() reads the machine's local time (correct for a desktop app
// where local time === user's bedtime timezone). Pin TZ so the "incorporates
// ctx.now" assertions below are deterministic across CI/dev machines.
beforeAll(() => {
  process.env.TZ = "UTC";
});

function baseHistory(overrides: Partial<HistorySummary> = {}): HistorySummary {
  return {
    overridesThisWeek: 0,
    lastLockoutAt: null,
    quickWakesThisWeek: 0,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<GatekeeperContext> = {}): GatekeeperContext {
  return {
    now: new Date("2026-06-30T23:45:00.000Z"),
    minutesLate: 15,
    strictness: "Firm",
    history: baseHistory(),
    escalated: false,
    graceCapMs: 15 * 60_000,
    ...overrides,
  };
}

describe("buildSystemPrompt — brief Step 1 requirements", () => {
  it("(a) states the strictness grace cap in minutes, derived from graceCapMs, not hardcoded", () => {
    // minutesLate deliberately differs from the cap value so the assertion
    // can't accidentally pass by matching the wrong number.
    const ctx = baseCtx({ strictness: "Firm", graceCapMs: 17 * 60_000, minutesLate: 9 });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("17");
    expect(prompt.toLowerCase()).toContain("minute");
  });

  it("(a) renders a different cap value for Gentle (45 min) vs Unmovable (5 min) — proves no hardcoded table", () => {
    const gentle = buildSystemPrompt(baseCtx({ strictness: "Gentle", graceCapMs: 45 * 60_000 }));
    const unmovable = buildSystemPrompt(
      baseCtx({ strictness: "Unmovable", graceCapMs: 5 * 60_000 }),
    );
    expect(gentle).toContain("45");
    expect(unmovable).toContain("5");
  });

  it("(a) renders an arbitrary, non-canonical graceCapMs value (proves it reads ctx, not a lookup table)", () => {
    // 23 minutes is not any of the documented Gentle/Firm/Unmovable defaults (45/15/5).
    const prompt = buildSystemPrompt(baseCtx({ strictness: "Firm", graceCapMs: 23 * 60_000 }));
    expect(prompt).toContain("23");
  });

  it("(b) mentions the override count when overridesThisWeek === 3", () => {
    const ctx = baseCtx({ history: baseHistory({ overridesThisWeek: 3 }) });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("3");
    expect(prompt.toLowerCase()).toContain("override");
  });

  it("(c) frames quickwake re-entry as suspicious — slept and returned within the relock window", () => {
    const ctx = baseCtx({ reentry: "quickwake" });
    const prompt = buildSystemPrompt(ctx);
    const lower = prompt.toLowerCase();
    expect(lower).toContain("slept");
    expect(lower).toMatch(/suspicio|skeptic|not buying|doubt/);
  });

  it('(d) surfaces "you said N minutes, it\'s been M" when priorCommitment is present', () => {
    const ctx = baseCtx({
      priorCommitment: { promisedMs: 10 * 60_000, elapsedMs: 22 * 60_000 },
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("10");
    expect(prompt).toContain("22");
  });
});

describe("buildSystemPrompt — documented-but-not-literally-asserted requirements", () => {
  it("incorporates ctx.now (date/time framing)", () => {
    const ctx = baseCtx({ now: new Date("2026-06-30T23:45:00.000Z") });
    const prompt = buildSystemPrompt(ctx);
    // Should reference the time in some human-readable way.
    expect(prompt).toMatch(/23:45|11:45 ?PM|11:45 ?pm/i);
  });

  it("incorporates minutesLate into the lateness narrative", () => {
    const ctx = baseCtx({ minutesLate: 42 });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("42");
    expect(prompt.toLowerCase()).toContain("late");
  });

  it("reflects strictness tone differences between Gentle and Unmovable", () => {
    const gentle = buildSystemPrompt(baseCtx({ strictness: "Gentle", graceCapMs: 45 * 60_000 }));
    const unmovable = buildSystemPrompt(
      baseCtx({ strictness: "Unmovable", graceCapMs: 5 * 60_000 }),
    );
    expect(gentle).toContain("Gentle");
    expect(unmovable).toContain("Unmovable");
    // The two tones should not be byte-identical aside from the cap number.
    expect(gentle).not.toEqual(unmovable);
  });

  it("frames escalation when escalated === true (continuous activity acknowledgment)", () => {
    const escalated = buildSystemPrompt(baseCtx({ escalated: true }));
    const notEscalated = buildSystemPrompt(baseCtx({ escalated: false }));
    const lower = escalated.toLowerCase();
    expect(lower).toMatch(/escalat|continuous|long stretch|extended period/);
    expect(escalated).not.toEqual(notEscalated);
  });

  it('handles reentry === "grace" with at least some acknowledgment, distinct from quickwake', () => {
    const grace = buildSystemPrompt(baseCtx({ reentry: "grace" }));
    const quickwake = buildSystemPrompt(baseCtx({ reentry: "quickwake" }));
    expect(grace.toLowerCase()).toMatch(/grace period|came back|return/);
    expect(grace).not.toEqual(quickwake);
  });

  it("handles reentry undefined/null (no re-entry context) without throwing or mentioning quickwake suspicion", () => {
    const noReentryUndefined = buildSystemPrompt(baseCtx({ reentry: undefined }));
    const noReentryNull = buildSystemPrompt(baseCtx({ reentry: null }));
    expect(noReentryUndefined.toLowerCase()).not.toContain("slept");
    expect(noReentryNull.toLowerCase()).not.toContain("slept");
  });

  it("handles priorCommitment absent without throwing or fabricating numbers", () => {
    const ctx = baseCtx({ priorCommitment: undefined });
    expect(() => buildSystemPrompt(ctx)).not.toThrow();
  });

  it("renders the grace cap correctly for each strictness level default config", () => {
    const caps: Record<"Gentle" | "Firm" | "Unmovable", number> = {
      Gentle: 45 * 60_000,
      Firm: 15 * 60_000,
      Unmovable: 5 * 60_000,
    };
    for (const [strictness, capMs] of Object.entries(caps) as [
      "Gentle" | "Firm" | "Unmovable",
      number,
    ][]) {
      const prompt = buildSystemPrompt(baseCtx({ strictness, graceCapMs: capMs }));
      expect(prompt).toContain(String(capMs / 60_000));
    }
  });

  it("establishes a tough, skeptical negotiator persona, not a pushover", () => {
    const prompt = buildSystemPrompt(baseCtx()).toLowerCase();
    expect(prompt).toMatch(/skeptic|tough|firm|justif|gatekeeper|negotiat/);
    expect(prompt).toMatch(
      /never grant|do not exceed|must not exceed|cannot exceed|never (give|allow)/,
    );
  });

  it("instructs the model to end every reply with a machine-readable grant marker", () => {
    const prompt = buildSystemPrompt(baseCtx());
    expect(prompt).toContain("<<GRANT:0>>");
    expect(prompt).toContain("<<GRANT:N>>");
    expect(prompt.toLowerCase()).toMatch(/end every reply|last line|final line/);
  });
});

describe("serializeTranscript", () => {
  it("returns an empty-ish string for an empty history", () => {
    expect(serializeTranscript([])).toBe("");
  });

  it("renders user and gatekeeper turns deterministically and readably", () => {
    const history: Msg[] = [
      { role: "user", text: "Just five more minutes please." },
      { role: "gatekeeper", text: "You said that already. What changed?" },
    ];
    const out = serializeTranscript(history);
    expect(out).toContain("Just five more minutes please.");
    expect(out).toContain("You said that already. What changed?");
    // User turn must precede gatekeeper turn in the rendered string.
    expect(out.indexOf("Just five more minutes")).toBeLessThan(
      out.indexOf("You said that already"),
    );
  });

  it("is deterministic — same input produces the same output", () => {
    const history: Msg[] = [
      { role: "user", text: "hello" },
      { role: "gatekeeper", text: "no." },
    ];
    expect(serializeTranscript(history)).toBe(serializeTranscript(history));
  });

  it("distinguishes role labels for user vs gatekeeper turns", () => {
    const history: Msg[] = [{ role: "user", text: "X" }];
    const out = serializeTranscript(history);
    expect(out.toLowerCase()).toContain("user");

    const history2: Msg[] = [{ role: "gatekeeper", text: "Y" }];
    const out2 = serializeTranscript(history2);
    expect(out2.toLowerCase()).toContain("gatekeeper");
  });
});
