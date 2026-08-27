import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GatekeeperPort } from "./ports";

/**
 * Resolves an absolute path to the `claude` executable.
 *
 * A GUI/login-item macOS app inherits only launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which excludes ~/.local/bin and Homebrew,
 * so a bare `spawn("claude")` fails with ENOENT even though `claude` resolves
 * fine in the user's interactive shell. We probe the common install locations
 * (plus whatever is already on PATH) and fall back to the bare name so an
 * unusual install still gets one last PATH-based attempt. An explicit
 * BEDTIME_CLAUDE_BIN override wins when it points at an existing file.
 */
export function resolveClaudeBin(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): string {
  const override = env.BEDTIME_CLAUDE_BIN;
  if (override && fileExists(override)) {
    return override;
  }

  const home = env.HOME ?? "";
  const pathDirs = (env.PATH ?? "").split(":").filter(Boolean);
  const candidateDirs = [
    ...(home ? [join(home, ".local", "bin")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...pathDirs,
  ];

  for (const dir of candidateDirs) {
    const candidate = join(dir, "claude");
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  return "claude";
}

/**
 * Distinguishes an unreachable-gatekeeper failure the user can act on
 * ("auth" — the claude CLI's login has expired, fixable by signing in again)
 * from one they can only wait out ("backend" — a timeout, crash, rate limit,
 * or other transient/opaque failure). Drives which message the overlay shows.
 */
export type GatekeeperFailureKind = "auth" | "backend";

/**
 * Thrown by ClaudeCliGatekeeper.ask() for ANY condition that means the
 * gatekeeper backend could not be reached or did not produce a trustworthy
 * answer: is_error:true, non-JSON stdout, non-zero exit, or timeout. This is
 * the fail-closed boundary mandated by issue #3 — callers (the Task 9+
 * controller) catch this specific type to keep the overlay up and log the
 * event as `gatekeeper_unreachable` (distinct from a genuine user override),
 * rather than treating an unreachable backend as a silent "yes".
 */
export class GatekeeperUnreachable extends Error {
  constructor(
    public reason: string,
    public kind: GatekeeperFailureKind = "backend",
  ) {
    super(reason);
    this.name = "GatekeeperUnreachable";
    // Restore the prototype chain so `instanceof GatekeeperUnreachable` keeps
    // working after transpilation (extending built-ins like Error can lose it).
    Object.setPrototypeOf(this, GatekeeperUnreachable.prototype);
  }
}

/**
 * True when a claude-CLI error message indicates its login/credentials are the
 * problem — the one failure the user can fix themselves (by re-authenticating)
 * rather than just waiting out.
 */
export function isAuthFailure(reason: string): boolean {
  return /authenticat|oauth|log ?in|sign ?in|credential|session expired|not logged in/i.test(
    reason,
  );
}

/**
 * Structural subset of node:child_process's spawn signature that
 * ClaudeCliGatekeeper actually depends on — narrow enough that a minimal
 * fake (EventEmitter + stdout/stderr EventEmitters + close/exit + kill) is a
 * legitimate drop-in for tests, but still type-compatible with the real
 * `spawn` so production code can omit it and get the real one by default.
 */
export type SpawnFn = (command: string, args: string[]) => ChildProcess;

// `claude -p` reads stdin and, launched from a GUI app with an open-but-empty
// stdin pipe, blocks ~3s ("no stdin data received in 3s") before proceeding.
// We never feed it stdin, so close it outright — this both removes that delay
// and follows the CLI's own advice ("redirect stdin explicitly: < /dev/null").
const defaultSpawn: SpawnFn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Optional diagnostic sink for the gatekeeper's spawn boundary. A packaged GUI
 * app has no visible stdout, so this is how the otherwise-invisible spawn/
 * stderr/close/timeout events can be surfaced (index.ts appends them to a file
 * under userData). No-op by default; never carries business logic.
 */
export type DebugLog = (line: string) => void;

export interface ClaudeCliGatekeeperOptions {
  spawn?: SpawnFn;
  timeoutMs?: number;
  binPath?: string;
  debugLog?: DebugLog;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
}

/**
 * Runs one spawned `claude -p ...` attempt to completion (or to timeout),
 * resolving with parsed stdout. Never resolves with anything but a parsed
 * ClaudeJsonResult — any other outcome rejects, so the caller's retry/
 * fail-closed logic has a single uniform failure channel to handle.
 */
function runOnce(
  spawnFn: SpawnFn,
  bin: string,
  args: string[],
  timeoutMs: number,
  debugLog: DebugLog,
): Promise<ClaudeJsonResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();

    debugLog(`spawn: ${bin}`);
    const child = spawnFn(bin, args);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      debugLog(`timeout after ${timeoutMs}ms`);
      child.kill?.();
      reject(new Error("timeout"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      debugLog(`stderr: ${text.trim()}`);
    });

    const onClose = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      debugLog(
        `close: code=${code} elapsedMs=${Date.now() - startedAt} stdoutLen=${stdout.length}`,
      );

      // Prefer the CLI's structured JSON whenever it's present: `claude -p
      // --output-format json` writes a well-formed result — including
      // is_error:true with the real, actionable reason (e.g. an expired
      // login) — even when it exits non-zero. Parsing it first means ask()
      // sees that reason instead of a generic "exited with code 1", so an
      // auth failure can be told apart from an opaque crash. The exit code
      // only decides the fallback when there's no JSON to read.
      let parsed: ClaudeJsonResult | null = null;
      try {
        parsed = JSON.parse(stdout) as ClaudeJsonResult;
      } catch {
        parsed = null;
      }

      if (parsed) {
        resolve(parsed);
        return;
      }

      if (stdout) {
        debugLog(`stdout-on-error: ${stdout.slice(0, 600).replace(/\s+/g, " ").trim()}`);
      }
      if (code !== 0) {
        reject(new Error(`process exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      reject(new Error("non-JSON output"));
    };

    // Only 'close' — not 'exit'. Node guarantees 'close' fires after all
    // stdio pipes have flushed; 'exit' can fire first while stdout data is
    // still buffered, which would truncate stdout and turn a real successful
    // reply into a spurious "non-JSON output" failure.
    child.on("close", onClose);
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tagged distinctly from other rejections so the caller's retry loop
      // can treat a spawn-level failure (ENOENT, EAGAIN, resource exhaustion)
      // the same way it treats a timeout: a transient, infrastructure-level
      // hiccup worth one retry, not a definitive CLI-side answer like
      // is_error/non-zero-exit/bad-JSON that retrying wouldn't fix.
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`spawn-error: ${message}`);
      reject(new Error(`spawn-error: ${message}`));
    });
  });
}

/**
 * Live `claude -p` backend for GatekeeperPort. Does NOT use `--resume`
 * (per issue #2 decision — app manages transcript history itself), so the
 * full conversation context is re-supplied as the prompt on every call.
 */
export class ClaudeCliGatekeeper implements GatekeeperPort {
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly binPath: string;
  private readonly debugLog: DebugLog;

  constructor(opts: ClaudeCliGatekeeperOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.binPath = opts.binPath ?? resolveClaudeBin();
    this.debugLog = opts.debugLog ?? (() => {});
  }

  async ask(
    systemPrompt: string,
    transcript: string,
    userMsg: string,
    opts?: { model?: "sonnet" | "haiku"; onDelta?: (text: string) => void },
  ): Promise<string> {
    const model = opts?.model ?? "sonnet";
    // Plain-text replay: transcript carries prior turns ("User: ...\nGatekeeper:
    // ...", per gatekeeper-prompt.ts's serializeTranscript), userMsg is the new
    // turn. Joined with a newline so the model reads it the way a human would
    // read a transcript followed by the next line; omitted entirely when there
    // is no prior transcript (first turn) so we don't prepend a stray newline.
    const prompt = transcript ? `${transcript}\n${userMsg}` : userMsg;

    const args = [
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--append-system-prompt",
      systemPrompt,
      prompt,
    ];

    // onDelta (streaming) is accepted for interface forward-compatibility
    // (the future stream-json --verbose --include-partial-messages path) but
    // is not implemented this task — ship the plain-json path first, per the
    // brief. We intentionally never call onDelta here.

    // Retry scope, per #3: "On timeout, retry the spawn exactly once." Timeout
    // and spawn-level errors (ENOENT, EAGAIN, resource exhaustion — tagged
    // 'spawn-error:' by runOnce) are both transient/infrastructure-level
    // hiccups worth one retry. Non-zero exit and non-JSON output are treated
    // as definitive failures of that attempt — retrying them would just
    // double a user's wait for no benefit on a condition that won't fix
    // itself between two near-instant calls. (A crash that's genuinely flaky
    // would still surface via the *next* user turn's fresh `ask()` call, so
    // nothing is silently lost — it just isn't retried within this single call.)
    for (let attempt = 0; attempt < 2; attempt++) {
      let parsed: ClaudeJsonResult;
      this.debugLog(`ask: attempt ${attempt} model=${model}`);
      try {
        parsed = await runOnce(this.spawnFn, this.binPath, args, this.timeoutMs, this.debugLog);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isTransient = message === "timeout" || message.startsWith("spawn-error:");
        if (isTransient && attempt === 0) {
          // First-attempt timeout or spawn error: retry once, per #3.
          continue;
        }
        const reason =
          message === "timeout"
            ? "timed out waiting for claude -p response (after retry)"
            : message;
        this.debugLog(`unreachable: ${reason}`);
        throw new GatekeeperUnreachable(reason);
      }

      if (parsed.is_error === true) {
        const reason = parsed.result ? parsed.result : "gatekeeper reported is_error";
        const kind = isAuthFailure(reason) ? "auth" : "backend";
        this.debugLog(`is_error (${kind}): ${reason}`);
        throw new GatekeeperUnreachable(reason, kind);
      }

      if (typeof parsed.result !== "string") {
        this.debugLog("malformed: missing result field");
        throw new GatekeeperUnreachable("malformed response: missing result field");
      }

      this.debugLog(`ok: resultLen=${parsed.result.length}`);
      return parsed.result;
    }

    // Unreachable in practice (the loop above always returns or throws), but
    // keeps the function's return type honest for the compiler.
    throw new GatekeeperUnreachable("gatekeeper unreachable: exhausted retries");
  }
}
