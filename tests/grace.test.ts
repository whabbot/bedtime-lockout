import { capGrace } from "../src/main/grace";
import { describe, it, expect } from "vitest";

describe("grace", () => {
  const caps = { Gentle: 45 * 60000, Firm: 15 * 60000, Unmovable: 5 * 60000 };

  it("caps requested grace at the strictness ceiling", () => {
    expect(capGrace(45 * 60000, "Firm", caps)).toBe(15 * 60000); // asked 45, Firm caps at 15
    expect(capGrace(10 * 60000, "Firm", caps)).toBe(10 * 60000); // under cap → honored
    expect(capGrace(30 * 60000, "Unmovable", caps)).toBe(5 * 60000); // Unmovable caps hard at 5
    expect(capGrace(-5, "Gentle", caps)).toBe(0); // negative → 0
  });
});
