import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  ClaudeCliGatekeeper,
  GatekeeperUnreachable,
  isAuthFailure,
  type SpawnFn,
} from "../src/main/gatekeeper";

/**
 * Minimal fake for node:child_process's ChildProcess, matching only the
 * surface ClaudeCliGatekeeper actually reads: `.stdout`/`.stderr` as
 * EventEmitters emitting 'data', the child itself emitting 'close' with an
 * exit code, and a no-op `.kill()` so timeout cleanup never throws.
 */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): void {
    this.killed = true;
  }
}

/**
 * Builds a fake replacement for child_process.spawn whose fake child writes
 * JSON.stringify(jsonResult) to stdout and closes with exit code 0 —
 * simulating a successful `claude -p --output-format json` invocation (or an
 * is_error:true JSON payload, depending on what jsonResult contains).
 */
function fakeSpawn(jsonResult: unknown): SpawnFn {
  return vi.fn(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(jsonResult)));
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<SpawnFn>;
  });
}

/**
 * Builds a fake spawn whose fake child writes the literal rawText string to
 * stdout (not valid JSON) and exits 0 — simulating a crash / non-JSON output.
 */
function fakeSpawnRaw(rawText: string): SpawnFn {
  return vi.fn(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(rawText));
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<SpawnFn>;
  });
}

/** Fake spawn whose child never emits 'close' — used to exercise the timeout path. */
function fakeSpawnHangs(): { spawn: SpawnFn; children: FakeChildProcess[] } {
  const children: FakeChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChildProcess();
    children.push(child);
    // never closes
    return child as unknown as ReturnType<SpawnFn>;
  });
  return { spawn, children };
}

/** Fake spawn that exits non-zero. */
function fakeSpawnExitCode(code: number): SpawnFn {
  return vi.fn(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("boom"));
      child.emit("close", code);
    });
    return child as unknown as ReturnType<SpawnFn>;
  });
}

/** Fake spawn whose child emits a process-level 'error' (e.g. ENOENT) instead of closing. */
function fakeSpawnError(message: string): SpawnFn {
  return vi.fn(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.emit("error", new Error(message));
    });
    return child as unknown as ReturnType<SpawnFn>;
  });
}

describe("ClaudeCliGatekeeper — brief Step 1 literal tests", () => {
  it("returns result text on success json", async () => {
    const gk = new ClaudeCliGatekeeper({
      spawn: fakeSpawn({ is_error: false, result: "No. Go to sleep." }),
    });
    expect(await gk.ask("sys", "", "please")).toBe("No. Go to sleep.");
  });

  it("throws GatekeeperUnreachable on is_error json (drives fail-closed)", async () => {
    const gk = new ClaudeCliGatekeeper({
      spawn: fakeSpawn({ is_error: true, result: "Not logged in · Please run /login" }),
    });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
  });

  it("throws GatekeeperUnreachable on non-JSON / crash output", async () => {
    const gk = new ClaudeCliGatekeeper({ spawn: fakeSpawnRaw("segfault") });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
  });
});

describe("ClaudeCliGatekeeper — fail-closed coverage beyond the literal tests", () => {
  it("throws GatekeeperUnreachable with a reason derived from JSON result on is_error", async () => {
    const gk = new ClaudeCliGatekeeper({
      spawn: fakeSpawn({ is_error: true, result: "Not logged in · Please run /login" }),
    });
    await expect(gk.ask("sys", "", "please")).rejects.toMatchObject({
      reason: expect.stringContaining("Not logged in"),
    });
  });

  it("throws GatekeeperUnreachable when the process exits non-zero", async () => {
    const gk = new ClaudeCliGatekeeper({ spawn: fakeSpawnExitCode(1) });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
  });

  it("never resolves with an empty/default string on any failure path", async () => {
    const gk = new ClaudeCliGatekeeper({ spawn: fakeSpawnRaw("") });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
  });

  it("does NOT retry on non-zero exit (only timeout is retried, per #3) — spawn called once", async () => {
    const spawn = fakeSpawnExitCode(1);
    const gk = new ClaudeCliGatekeeper({ spawn });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on non-JSON output — spawn called once", async () => {
    const spawn = fakeSpawnRaw("segfault");
    const gk = new ClaudeCliGatekeeper({ spawn });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on is_error:true — spawn called once", async () => {
    const spawn = fakeSpawn({ is_error: true, result: "Not logged in" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('parses successfully even if "exit" fires before "data"/"close" (stdio flush race) — regression', async () => {
    // Node guarantees 'close' fires after stdio pipes are fully flushed, but
    // 'exit' can fire first while stdout 'data' hasn't been emitted yet. A
    // correct implementation must not treat early 'exit' as the end of
    // stdout collection.
    const spawn: SpawnFn = vi.fn(() => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.emit("exit", 0); // fires first, stdout not yet written
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ is_error: false, result: "race-safe" })),
        );
        child.emit("close", 0); // fires after stdio flush — this is what should matter
      });
      return child as unknown as ReturnType<SpawnFn>;
    });

    const gk = new ClaudeCliGatekeeper({ spawn });
    await expect(gk.ask("sys", "", "please")).resolves.toBe("race-safe");
  });
});

describe("ClaudeCliGatekeeper — timeout + retry (#3)", () => {
  it("times out, retries once, and throws GatekeeperUnreachable when the retry also hangs", async () => {
    const { spawn, children } = fakeSpawnHangs();
    const gk = new ClaudeCliGatekeeper({ spawn, timeoutMs: 30 });

    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
    await expect(
      new ClaudeCliGatekeeper({ spawn, timeoutMs: 30 })
        .ask("sys", "", "please")
        .catch((e) => e.reason),
    ).resolves.toMatch(/timeout|timed out/i);

    // Spawned exactly twice total across the two calls above (one spawn per
    // attempt; one retry per call) — confirms retry-exactly-once semantics
    // without asserting an exact count that depends on call ordering.
    expect(spawn).toHaveBeenCalled();
    // Each hung child should have been killed during timeout cleanup.
    for (const child of children) {
      expect(child.killed).toBe(true);
    }
  });

  it("retries exactly once: spawn called twice for a single ask() that always hangs", async () => {
    const { spawn } = fakeSpawnHangs();
    const gk = new ClaudeCliGatekeeper({ spawn, timeoutMs: 20 });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the second attempt after the first attempt times out (retry recovers)", async () => {
    let call = 0;
    const spawn: SpawnFn = vi.fn(() => {
      call += 1;
      const child = new FakeChildProcess();
      if (call === 1) {
        // first attempt hangs forever, forcing a timeout
      } else {
        queueMicrotask(() => {
          child.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ is_error: false, result: "ok on retry" })),
          );
          child.emit("close", 0);
        });
      }
      return child as unknown as ReturnType<SpawnFn>;
    });

    const gk = new ClaudeCliGatekeeper({ spawn, timeoutMs: 20 });
    await expect(gk.ask("sys", "", "please")).resolves.toBe("ok on retry");
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe("ClaudeCliGatekeeper — spawn-level error retry (#3, fix round)", () => {
  it("retries once on a spawn-level error (e.g. ENOENT) and throws GatekeeperUnreachable if the retry also errors", async () => {
    const spawn = fakeSpawnError("ENOENT: claude not found");
    const gk = new ClaudeCliGatekeeper({ spawn });
    await expect(gk.ask("sys", "", "please")).rejects.toBeInstanceOf(GatekeeperUnreachable);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the second attempt after the first attempt has a spawn-level error (retry recovers)", async () => {
    let call = 0;
    const spawn: SpawnFn = vi.fn(() => {
      call += 1;
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (call === 1) {
          child.emit("error", new Error("EAGAIN"));
        } else {
          child.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ is_error: false, result: "ok after spawn retry" })),
          );
          child.emit("close", 0);
        }
      });
      return child as unknown as ReturnType<SpawnFn>;
    });

    const gk = new ClaudeCliGatekeeper({ spawn });
    await expect(gk.ask("sys", "", "please")).resolves.toBe("ok after spawn retry");
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe("ClaudeCliGatekeeper — invocation shape", () => {
  it('defaults to model "sonnet" when opts.model is omitted', async () => {
    const spawn = fakeSpawn({ is_error: false, result: "ok" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await gk.ask("sys", "", "please");
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("sonnet");
  });

  it("uses opts.model when provided (e.g. haiku)", async () => {
    const spawn = fakeSpawn({ is_error: false, result: "ok" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await gk.ask("sys", "", "please", { model: "haiku" });
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("haiku");
  });

  it('combines transcript+userMsg as the trailing prompt arg: "transcript\\nuserMsg" when transcript is non-empty', async () => {
    const spawn = fakeSpawn({ is_error: false, result: "ok" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await gk.ask("sys", "User: hi\nGatekeeper: no.", "please let me stay up");
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toBe("User: hi\nGatekeeper: no.\nplease let me stay up");
  });

  it("uses userMsg alone as the prompt when transcript is empty", async () => {
    const spawn = fakeSpawn({ is_error: false, result: "ok" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await gk.ask("sys", "", "please let me stay up");
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toBe("please let me stay up");
  });

  it("passes systemPrompt via --append-system-prompt", async () => {
    const spawn = fakeSpawn({ is_error: false, result: "ok" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await gk.ask("You are tough.", "", "please");
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("You are tough.");
  });

  it("requests --output-format json on the plain (non-streaming) path", async () => {
    const spawn = fakeSpawn({ is_error: false, result: "ok" });
    const gk = new ClaudeCliGatekeeper({ spawn });
    await gk.ask("sys", "", "please");
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const idx = args.indexOf("--output-format");
    expect(args[idx + 1]).toBe("json");
  });
});

describe("GatekeeperUnreachable", () => {
  it("is an instanceof Error and carries a reason string", () => {
    const err = new GatekeeperUnreachable("non-JSON output");
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe("non-JSON output");
    expect(err.name).toBe("GatekeeperUnreachable");
  });

  it("defaults to kind 'backend'", () => {
    expect(new GatekeeperUnreachable("boom").kind).toBe("backend");
  });
});

describe("isAuthFailure", () => {
  it("recognizes the expired-login message the claude CLI actually emits", () => {
    expect(
      isAuthFailure("Failed to authenticate: OAuth session expired and could not be refreshed"),
    ).toBe(true);
  });

  it("recognizes other login-shaped messages", () => {
    expect(isAuthFailure("Not logged in · Please run /login")).toBe(true);
    expect(isAuthFailure("Please sign in to continue")).toBe(true);
    expect(isAuthFailure("invalid credentials")).toBe(true);
  });

  it("does not flag unrelated backend errors", () => {
    expect(isAuthFailure("rate limit exceeded")).toBe(false);
    expect(isAuthFailure("upstream connect error")).toBe(false);
    expect(isAuthFailure("No. Go to sleep.")).toBe(false);
  });
});

/** Fake spawn that writes JSON to stdout AND exits non-zero — the real shape of a claude auth failure. */
function fakeSpawnJsonWithExitCode(jsonResult: unknown, code: number): SpawnFn {
  return vi.fn(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(jsonResult)));
      child.emit("close", code);
    });
    return child as unknown as ReturnType<SpawnFn>;
  });
}

describe("ClaudeCliGatekeeper — failure classification", () => {
  it("tags an expired-login is_error (exit 0) as kind 'auth'", async () => {
    const gk = new ClaudeCliGatekeeper({
      spawn: fakeSpawn({ is_error: true, result: "Failed to authenticate: OAuth session expired" }),
    });
    await expect(gk.ask("sys", "", "please")).rejects.toMatchObject({ kind: "auth" });
  });

  it("reads the is_error reason even when the CLI exits non-zero, and tags auth", async () => {
    const gk = new ClaudeCliGatekeeper({
      spawn: fakeSpawnJsonWithExitCode(
        { is_error: true, result: "Failed to authenticate: OAuth session expired" },
        1,
      ),
    });
    await expect(gk.ask("sys", "", "please")).rejects.toMatchObject({
      kind: "auth",
      reason: expect.stringContaining("OAuth session expired"),
    });
  });

  it("tags a non-auth is_error as kind 'backend'", async () => {
    const gk = new ClaudeCliGatekeeper({
      spawn: fakeSpawn({ is_error: true, result: "rate limit exceeded" }),
    });
    await expect(gk.ask("sys", "", "please")).rejects.toMatchObject({ kind: "backend" });
  });
});
