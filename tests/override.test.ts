import { describe, it, expect } from "vitest";
import { matchOverride } from "../src/main/override";

describe("matchOverride", () => {
  it("matches case-insensitively and trimmed, not as substring", () => {
    expect(matchOverride("  Let Me Through Tonight ", "let me through tonight")).toBe(true);
    expect(matchOverride("please let me through tonight now", "let me through tonight")).toBe(
      false,
    );
  });

  it("collapses internal whitespace before comparing", () => {
    expect(matchOverride("let   me  through   tonight", "let me through tonight")).toBe(true);
  });

  it("does not match when the phrase is only a prefix or suffix", () => {
    expect(matchOverride("let me through tonight please", "let me through tonight")).toBe(false);
    expect(matchOverride("well let me through tonight", "let me through tonight")).toBe(false);
  });
});
