// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/main/settings";
import type { OverlayState } from "../src/main/overlay-ipc";

const HTML = readFileSync(join(process.cwd(), "src/renderer/overlay/index.html"), "utf8");
const BODY_HTML = HTML.replace(/[\s\S]*?<body[^>]*>/, "")
  .replace(/<\/body>[\s\S]*/, "")
  .replace(/<script[\s\S]*?<\/script>/g, "");

function coldState(): OverlayState {
  return {
    mode: "cold",
    minutesLate: 0,
    strictness: "Firm",
    graceCapMin: 15,
    overridePhrase: DEFAULTS.overridePhrase,
    transcript: [],
  };
}

interface Loaded {
  handlers: {
    onState?: (s: OverlayState) => void;
    onGatekeeperDown?: (kind?: "auth" | "backend") => void;
    onThinking?: (t: boolean) => void;
    onReply?: (r: string) => void;
  };
  submitOverride: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  requestSleep: ReturnType<typeof vi.fn>;
}

async function loadOverlay(): Promise<Loaded> {
  document.body.innerHTML = BODY_HTML;

  const handlers: Loaded["handlers"] = {};
  const submitOverride = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn().mockResolvedValue({ unreachable: true });
  const requestSleep = vi.fn();

  (window as unknown as { btl: unknown }).btl = {
    sendMessage,
    submitOverride,
    requestSleep,
    onState: (cb: (s: OverlayState) => void) => {
      handlers.onState = cb;
    },
    onThinking: (cb: (t: boolean) => void) => {
      handlers.onThinking = cb;
    },
    onGatekeeperDown: (cb: (kind?: "auth" | "backend") => void) => {
      handlers.onGatekeeperDown = cb;
    },
    onReply: (cb: (r: string) => void) => {
      handlers.onReply = cb;
    },
  };

  vi.resetModules();
  await import("../src/renderer/overlay/main");
  return { handlers, submitOverride, sendMessage, requestSleep };
}

function submitForm(id: string): void {
  const form = document.getElementById(id) as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

describe("overlay renderer — the lock button", () => {
  it("locks the Mac on a single click, with no confirmation step", async () => {
    const app = await loadOverlay();
    app.handlers.onState!(coldState());

    (document.getElementById("sleep-btn") as HTMLButtonElement).click();

    expect(app.requestSleep).toHaveBeenCalledTimes(1);
  });
});

describe("overlay renderer — override is not gated on gatekeeper health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows the auth-specific message (sign in again) when the gatekeeper is down for auth", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!("auth");

    const title = document.getElementById("gatekeeper-down-title") as HTMLElement;
    const hint = document.getElementById("gatekeeper-down-hint") as HTMLElement;
    expect(title.textContent).toContain("signed out");
    expect(hint.textContent).toContain("sign in");
  });

  it("shows the generic message when the gatekeeper is down for a backend failure", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!("backend");

    const title = document.getElementById("gatekeeper-down-title") as HTMLElement;
    expect(title.textContent).toContain("can't be reached");
  });

  it("override submit reaches btl.submitOverride even when the gatekeeper is down", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!("backend");

    (document.getElementById("override-text") as HTMLInputElement).value = DEFAULTS.overridePhrase;
    submitForm("override-form");

    expect(app.submitOverride).toHaveBeenCalledWith(DEFAULTS.overridePhrase);
  });

  it("a state render after gatekeeper-down leaves the override input usable", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!();
    app.handlers.onState!(coldState());

    expect((document.getElementById("override-text") as HTMLInputElement).disabled).toBe(false);
  });

  it("chat stays gated when the gatekeeper is down", async () => {
    const app = await loadOverlay();
    app.handlers.onGatekeeperDown!();

    (document.getElementById("input-text") as HTMLInputElement).value = "please let me keep going";
    submitForm("input-form");

    expect(app.sendMessage).not.toHaveBeenCalled();
  });

  it("chat submit reaches btl.sendMessage when the gatekeeper is up (positive control)", async () => {
    const app = await loadOverlay();

    (document.getElementById("input-text") as HTMLInputElement).value = "please let me keep going";
    submitForm("input-form");

    expect(app.sendMessage).toHaveBeenCalledWith("please let me keep going");
  });
});
