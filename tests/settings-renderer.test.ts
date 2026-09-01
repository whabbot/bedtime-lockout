// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, type Settings } from "../src/main/settings";

const HTML = readFileSync(join(process.cwd(), "src/renderer/settings/index.html"), "utf8");
const BODY_HTML = HTML.replace(/[\s\S]*?<body[^>]*>/, "")
  .replace(/<\/body>[\s\S]*/, "")
  .replace(/<script[\s\S]*?<\/script>/g, "");

interface Loaded {
  getSettings: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  snoozedUntilMs: ReturnType<typeof vi.fn>;
  resetSnooze: ReturnType<typeof vi.fn>;
}

async function loadSettings(
  settings: Settings = DEFAULTS,
  snoozedUntil: number | null = null,
): Promise<Loaded> {
  document.body.innerHTML = BODY_HTML;

  const getSettings = vi.fn().mockResolvedValue(settings);
  const saveSettings = vi.fn().mockImplementation((s: Settings) => Promise.resolve(s));
  const snoozedUntilMs = vi.fn().mockResolvedValue(snoozedUntil);
  const resetSnooze = vi.fn().mockResolvedValue(null);

  (window as unknown as { btlSettings: unknown }).btlSettings = {
    getSettings,
    saveSettings,
    snoozedUntilMs,
    resetSnooze,
  };

  vi.resetModules();
  await import("../src/renderer/settings/main");
  // The module kicks off its initial load() asynchronously; let it settle.
  await Promise.resolve();
  await Promise.resolve();

  return { getSettings, saveSettings, snoozedUntilMs, resetSnooze };
}

const snoozeRow = (): HTMLElement => document.getElementById("snooze-row") as HTMLElement;

describe("settings renderer", () => {
  it("renders the persisted settings into the form", async () => {
    await loadSettings({ ...DEFAULTS, lockoutTime: "22:45", wakeTime: "06:15" });

    expect((document.getElementById("lockout-time") as HTMLInputElement).value).toBe("22:45");
    expect((document.getElementById("wake-time") as HTMLInputElement).value).toBe("06:15");
    expect((document.getElementById("override-phrase") as HTMLInputElement).value).toBe(
      DEFAULTS.overridePhrase,
    );
  });

  it("saves edited fields back through the bridge", async () => {
    const app = await loadSettings();

    (document.getElementById("lockout-time") as HTMLInputElement).value = "23:00";
    (document.getElementById("save-btn") as HTMLButtonElement).click();
    await Promise.resolve();

    expect(app.saveSettings).toHaveBeenCalledTimes(1);
    expect(app.saveSettings.mock.calls[0][0].lockoutTime).toBe("23:00");
  });

  it("hides the snooze row when nothing is snoozed", async () => {
    await loadSettings();
    expect(snoozeRow().hidden).toBe(true);
  });

  it("shows the snooze time while an override night is standing the app down", async () => {
    await loadSettings(DEFAULTS, new Date(2026, 5, 30, 7, 0).getTime());

    expect(snoozeRow().hidden).toBe(false);
    expect((document.getElementById("snooze-until") as HTMLElement).textContent).toContain("7:00");
  });

  it("resets the snooze and hides the row once it's cleared", async () => {
    const app = await loadSettings(DEFAULTS, new Date(2026, 5, 30, 7, 0).getTime());

    (document.getElementById("reset-snooze-btn") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.resetSnooze).toHaveBeenCalledTimes(1);
    expect(snoozeRow().hidden).toBe(true);
  });
});
