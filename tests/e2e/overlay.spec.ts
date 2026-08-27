import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/main/settings";

function seedLockedNight(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), "btl-e2e-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ ...DEFAULTS, dev: { windowedOverlay: true } }),
  );
  writeFileSync(
    join(userDataDir, "sm.json"),
    JSON.stringify({ phase: "LOCKED", triggerAt: 0, escalated: false }),
  );
  return userDataDir;
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["out/main/index.js", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, BEDTIME_CLAUDE_BIN: "/usr/bin/false" },
  });
}

async function readPhase(app: ElectronApplication): Promise<string> {
  const userDataPath = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData"),
  );
  const sm = JSON.parse(readFileSync(join(userDataPath, "sm.json"), "utf8"));
  return sm.phase as string;
}

test("override works when the cage is up", async () => {
  const userDataDir = seedLockedNight();
  const app = await launch(userDataDir);
  const win = await app.firstWindow();

  await win.fill("#override-text", DEFAULTS.overridePhrase);
  await win.click("#override-send");

  await expect.poll(() => readPhase(app)).toBe("OVERRIDE_NIGHT");
  await app.close();
});

test("override works even when the gatekeeper is down", async () => {
  const userDataDir = seedLockedNight();
  const app = await launch(userDataDir);
  const win = await app.firstWindow();

  // Drive the renderer into gatekeeper-down via a failed chat round-trip.
  await win.fill("#input-text", "please let me keep going");
  await win.press("#input-text", "Enter");
  await expect(win.locator("#gatekeeper-down")).toBeVisible();

  // Override must still round-trip to the Controller with the gatekeeper down.
  await win.fill("#override-text", DEFAULTS.overridePhrase);
  await win.click("#override-send");

  await expect.poll(() => readPhase(app)).toBe("OVERRIDE_NIGHT");
  await app.close();
});
