/**
 * Manual smoke test for ClaudeCliGatekeeper (Task 8, Step 5) — NOT part of
 * `npm test`. Calls the real `claude -p` CLI via the real node:child_process
 * spawn (no fake/injected spawn) and records wall-clock latency. Requires a
 * machine with `claude` on PATH and already logged in.
 *
 * Run with: npx tsx scripts/smoke-gatekeeper.ts
 */
import { ClaudeCliGatekeeper } from "../src/main/gatekeeper";

async function main() {
  const gk = new ClaudeCliGatekeeper(); // real spawn, real 30s default timeout

  const systemPrompt =
    "You are the Gatekeeper: a tough, skeptical negotiator enforcing a bedtime lockout. " +
    "Keep your reply to one short sentence.";
  const userMsg = "Please let me stay up five more minutes.";

  console.log("Calling ClaudeCliGatekeeper.ask() against the real claude CLI...");
  const start = Date.now();
  try {
    const result = await gk.ask(systemPrompt, "", userMsg, { model: "haiku" });
    const elapsedMs = Date.now() - start;
    console.log(`\nSUCCESS in ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);
    console.log("Reply:", result);
  } catch (err) {
    const elapsedMs = Date.now() - start;
    console.error(`\nFAILED after ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);
    console.error(err);
    process.exitCode = 1;
  }
}

main();
