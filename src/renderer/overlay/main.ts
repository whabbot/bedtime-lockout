import type { OverlayState } from "../../main/overlay-ipc";
import type { Msg } from "../../main/gatekeeper-prompt";
import type { GatekeeperFailureKind } from "../../main/gatekeeper";
import {
  coldProse,
  formatClock,
  graceHint,
  overrideFooter,
  overrideHint,
  overrideSubline,
  quickwakeChip,
  quickwakeProse,
  relockChip,
  relockProse,
  statusLine,
} from "./copy";

declare global {
  interface Window {
    btl: {
      sendMessage(text: string): Promise<{ reply: string } | { unreachable: true }>;
      submitOverride(text: string): Promise<boolean>;
      requestSleep(): void;
      onState(cb: (state: OverlayState) => void): void;
      onThinking(cb: (thinking: boolean) => void): void;
      onGatekeeperDown(cb: (kind: GatekeeperFailureKind) => void): void;
      onReply(cb: (reply: string) => void): void;
    };
  }
}

const clockEl = document.getElementById("clock") as HTMLElement;
const stageEl = document.querySelector(".stage") as HTMLElement;
const statusLineEl = document.getElementById("status-line") as HTMLElement;
const reentryChipEl = document.getElementById("reentry-chip") as HTMLElement;
const proseEl = document.getElementById("prose") as HTMLElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;
const thinkingEl = document.getElementById("thinking") as HTMLElement;
const gatekeeperDownEl = document.getElementById("gatekeeper-down") as HTMLElement;
const gatekeeperDownTitleEl = document.getElementById("gatekeeper-down-title") as HTMLElement;
const gatekeeperDownHintEl = document.getElementById("gatekeeper-down-hint") as HTMLElement;
const inputFormEl = document.getElementById("input-form") as HTMLFormElement;
const inputTextEl = document.getElementById("input-text") as HTMLInputElement;
const overrideHintEl = document.getElementById("override-hint") as HTMLElement;
const overrideFormEl = document.getElementById("override-form") as HTMLFormElement;
const overrideTextEl = document.getElementById("override-text") as HTMLInputElement;
const sleepBtnEl = document.getElementById("sleep-btn") as HTMLButtonElement;
const overrideFooterEl = document.getElementById("override-footer") as HTMLElement;

let currentState: OverlayState | null = null;
let gatekeeperDown = false;

function tickClock(): void {
  clockEl.textContent = formatClock(new Date());
}
tickClock();
setInterval(tickClock, 1000);

function renderMsg(msg: Msg): HTMLElement {
  const el = document.createElement("div");
  el.className = msg.role === "user" ? "msg msg-user" : "msg msg-gatekeeper";
  el.textContent = msg.text;
  return el;
}

/**
 * Paints the DOM for one `OverlayState` push. Purely presentational: every
 * branch below only reads fields already present on `state` — no timers, no
 * phase inference, no gatekeeper calls. `mode` is treated as authoritative,
 * never re-derived from `transcript.length` or anything else client-side.
 */
function render(state: OverlayState): void {
  currentState = state;
  stageEl.dataset.mode = state.mode;

  reentryChipEl.hidden = true;
  transcriptEl.hidden = true;
  proseEl.hidden = false;
  overrideFooterEl.hidden = true;
  statusLineEl.hidden = false;
  inputTextEl.placeholder = "What are you still working on?";

  switch (state.mode) {
    case "cold": {
      statusLineEl.textContent = statusLine(new Date(), state);
      proseEl.textContent = coldProse(new Date(), state);
      break;
    }
    case "mid": {
      statusLineEl.textContent = statusLine(new Date(), state);
      proseEl.hidden = true;
      transcriptEl.hidden = false;
      transcriptEl.replaceChildren(...state.transcript.map(renderMsg));
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      inputTextEl.placeholder = "Tell it why you're still up…";
      break;
    }
    case "relock": {
      statusLineEl.textContent = `${statusLine(new Date(), state)} · re-locked`;
      const chip = relockChip(state);
      if (chip) {
        reentryChipEl.textContent = chip;
        reentryChipEl.hidden = false;
      }
      proseEl.textContent = relockProse(state);
      break;
    }
    case "quickwake": {
      statusLineEl.textContent = statusLine(new Date(), state);
      const chip = quickwakeChip(state);
      if (chip) {
        reentryChipEl.textContent = chip;
        reentryChipEl.hidden = false;
      }
      proseEl.textContent = quickwakeProse(state);
      break;
    }
    case "override": {
      statusLineEl.hidden = true;
      proseEl.textContent = `Override accepted. I'll step back for tonight. ${overrideSubline(state)}`;
      const footer = overrideFooter(state);
      if (footer) {
        overrideFooterEl.textContent = footer;
        overrideFooterEl.hidden = false;
      }
      break;
    }
  }

  overrideHintEl.hidden = state.mode === "override";
  const showGraceHint = state.mode === "mid" || state.mode === "relock";
  overrideHintEl.textContent = showGraceHint
    ? `${overrideHint(state)} · ${graceHint(state)}`
    : overrideHint(state);

  const inputAllowed = state.mode !== "override" && !gatekeeperDown;
  inputFormEl.classList.toggle("disabled", !inputAllowed);
  inputTextEl.disabled = !inputAllowed;

  const overrideAllowed = state.mode !== "override";
  overrideFormEl.hidden = state.mode === "override";
  overrideFormEl.classList.toggle("disabled", !overrideAllowed);
  overrideTextEl.disabled = !overrideAllowed;

  sleepBtnEl.hidden = state.mode === "override";
}

function setThinking(thinking: boolean): void {
  thinkingEl.hidden = !thinking;
}

const GATEKEEPER_DOWN_COPY: Record<GatekeeperFailureKind, { title: string; hint: string }> = {
  backend: {
    title:
      "The gatekeeper can't be reached right now, so the overlay stays up rather than letting you through unchecked.",
    hint: "Lock the Mac, or wait and try again shortly.",
  },
  auth: {
    title:
      "The gatekeeper can't run because Claude is signed out — so the overlay stays up rather than letting you through unchecked.",
    hint: "Open Terminal, run claude to sign in again, then try once more — or lock the Mac.",
  },
};

function setGatekeeperDown(kind: GatekeeperFailureKind = "backend"): void {
  gatekeeperDown = true;
  const copy = GATEKEEPER_DOWN_COPY[kind] ?? GATEKEEPER_DOWN_COPY.backend;
  gatekeeperDownTitleEl.textContent = copy.title;
  gatekeeperDownHintEl.textContent = copy.hint;
  gatekeeperDownEl.hidden = false;
  inputFormEl.classList.add("disabled");
  inputTextEl.disabled = true;
  sleepBtnEl.classList.add("primary-escape");
}

window.btl.onState(render);
window.btl.onThinking(setThinking);
window.btl.onGatekeeperDown(setGatekeeperDown);
window.btl.onReply(() => {
  // Transcript content itself arrives via the next `onState` push; this
  // handler exists so the renderer can react to reply-arrival (e.g. stop the
  // thinking indicator immediately) without waiting on that push.
  setThinking(false);
});

/**
 * Shows the user's message the instant they send it, rather than waiting for
 * the gatekeeper round-trip to return and repaint via `onState`. The authoritative
 * `onState` push that follows uses `replaceChildren`, so this echo is replaced,
 * not duplicated. If the gatekeeper is slow or never answers, the message plus
 * the thinking indicator stay on screen instead of the input vanishing silently.
 */
function echoUserMessage(text: string): void {
  proseEl.hidden = true;
  transcriptEl.hidden = false;
  transcriptEl.appendChild(renderMsg({ role: "user", text }));
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

inputFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputTextEl.value.trim();
  if (!text || gatekeeperDown) return;
  inputTextEl.value = "";
  echoUserMessage(text);
  setThinking(true);
  void window.btl.sendMessage(text).then(() => {
    // On failure the gatekeeper-down panel (with its specific reason) is driven
    // by the onGatekeeperDown push that always accompanies an unreachable
    // result — the push carries the failure kind, which this resolution does
    // not — so all that's needed here is to stop the thinking indicator.
    setThinking(false);
  });
});

overrideFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = overrideTextEl.value.trim();
  if (!text) return;
  overrideTextEl.value = "";
  void window.btl.submitOverride(text);
});

sleepBtnEl.addEventListener("click", () => {
  window.btl.requestSleep();
});
