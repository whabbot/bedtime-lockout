import { describe, it, expect } from "vitest";
import { resolveClaudeBin } from "../src/main/gatekeeper";

describe("resolveClaudeBin", () => {
  it("prefers ~/.local/bin/claude when present", () => {
    const env = { HOME: "/home/u", PATH: "/usr/bin:/bin" };
    const exists = (p: string) => p === "/home/u/.local/bin/claude";
    expect(resolveClaudeBin(env, exists)).toBe("/home/u/.local/bin/claude");
  });

  it("falls back to a directory already on PATH when standard locations are absent", () => {
    const env = { HOME: "/home/u", PATH: "/opt/tools/bin:/bin" };
    const exists = (p: string) => p === "/opt/tools/bin/claude";
    expect(resolveClaudeBin(env, exists)).toBe("/opt/tools/bin/claude");
  });

  it("honors a BEDTIME_CLAUDE_BIN override when it exists", () => {
    const env = { HOME: "/home/u", PATH: "/bin", BEDTIME_CLAUDE_BIN: "/custom/claude" };
    const exists = (p: string) => p === "/custom/claude" || p === "/home/u/.local/bin/claude";
    expect(resolveClaudeBin(env, exists)).toBe("/custom/claude");
  });

  it("ignores a BEDTIME_CLAUDE_BIN override that does not exist", () => {
    const env = { HOME: "/home/u", PATH: "/bin", BEDTIME_CLAUDE_BIN: "/gone/claude" };
    const exists = (p: string) => p === "/home/u/.local/bin/claude";
    expect(resolveClaudeBin(env, exists)).toBe("/home/u/.local/bin/claude");
  });

  it("falls back to the bare name so PATH still gets one last attempt", () => {
    const env = { HOME: "/home/u", PATH: "/bin" };
    expect(resolveClaudeBin(env, () => false)).toBe("claude");
  });
});
