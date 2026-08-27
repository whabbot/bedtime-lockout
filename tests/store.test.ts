import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";

describe("Store", () => {
  it("round-trips a value and survives a re-read", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const s = new Store(dir);
    s.write("state", { phase: "LOCKED" });
    expect(new Store(dir).read("state", null)).toEqual({ phase: "LOCKED" });
  });

  it("returns the fallback when the key has never been written", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const s = new Store(dir);
    expect(s.read("missing", { foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("does not leave a .tmp file behind after a write", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const s = new Store(dir);
    s.write("settings", { a: 1 });
    const files = readdirSync(dir);
    expect(files).toContain("settings.json");
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites a previous value for the same key", () => {
    const dir = mkdtempSync(join(tmpdir(), "btl-"));
    const s = new Store(dir);
    s.write("count", { n: 1 });
    s.write("count", { n: 2 });
    expect(s.read("count", null)).toEqual({ n: 2 });
  });
});
