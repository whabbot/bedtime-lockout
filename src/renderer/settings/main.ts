import type { Settings, Strictness } from "../../main/settings";

declare global {
  interface Window {
    btlSettings: {
      getSettings(): Promise<Settings>;
      saveSettings(settings: Settings): Promise<Settings>;
    };
  }
}

const lockoutTimeEl = document.getElementById("lockout-time") as HTMLInputElement;
const countdownChipsEl = document.getElementById("countdown-chips") as HTMLElement;
const countdownAddFormEl = document.getElementById("countdown-add-form") as HTMLFormElement;
const countdownAddInputEl = document.getElementById("countdown-add-input") as HTMLInputElement;
const overridePhraseEl = document.getElementById("override-phrase") as HTMLInputElement;
const strictnessSegmentedEl = document.getElementById("strictness-segmented") as HTMLElement;
const wakeTimeEl = document.getElementById("wake-time") as HTMLInputElement;
const saveBtnEl = document.getElementById("save-btn") as HTMLButtonElement;
const saveStatusEl = document.getElementById("save-status") as HTMLElement;

// The in-memory copy of Settings this window edits; saving always round-trips
// the full object through mergeSettings on the main side, so a per-field edit
// can never blow away fields the user didn't touch.
let current: Settings;

function renderCountdownChips(leads: number[]): void {
  countdownChipsEl.replaceChildren(
    ...leads.map((min) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const label = document.createElement("span");
      label.textContent = `${min} min`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${min} min reminder`);
      remove.addEventListener("click", () => {
        current.countdownLeadsMin = current.countdownLeadsMin.filter((m) => m !== min);
        renderCountdownChips(current.countdownLeadsMin);
      });
      chip.append(label, remove);
      return chip;
    }),
  );
}

function renderStrictness(value: Strictness): void {
  for (const btn of strictnessSegmentedEl.querySelectorAll("button")) {
    btn.classList.toggle("selected", btn.dataset.value === value);
  }
}

function render(settings: Settings): void {
  current = settings;
  lockoutTimeEl.value = settings.lockoutTime;
  wakeTimeEl.value = settings.wakeTime;
  overridePhraseEl.value = settings.overridePhrase;
  renderCountdownChips(settings.countdownLeadsMin);
  renderStrictness(settings.strictness);
}

async function load(): Promise<void> {
  render(await window.btlSettings.getSettings());
}

countdownAddFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const min = Number(countdownAddInputEl.value);
  countdownAddInputEl.value = "";
  if (!Number.isFinite(min) || min <= 0) return;
  if (current.countdownLeadsMin.includes(min)) return;
  current.countdownLeadsMin = [...current.countdownLeadsMin, min].sort((a, b) => a - b);
  renderCountdownChips(current.countdownLeadsMin);
});

strictnessSegmentedEl.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest("button");
  if (!target?.dataset.value) return;
  renderStrictness(target.dataset.value as Strictness);
});

saveBtnEl.addEventListener("click", () => {
  void save();
});

async function save(): Promise<void> {
  const selectedStrictness = strictnessSegmentedEl.querySelector("button.selected") as
    | HTMLButtonElement
    | undefined;

  const next: Settings = {
    ...current,
    lockoutTime: lockoutTimeEl.value,
    wakeTime: wakeTimeEl.value,
    overridePhrase: overridePhraseEl.value,
    strictness: (selectedStrictness?.dataset.value as Strictness) ?? current.strictness,
    countdownLeadsMin: current.countdownLeadsMin,
  };

  saveStatusEl.textContent = "Saving…";
  const saved = await window.btlSettings.saveSettings(next);
  render(saved);
  saveStatusEl.textContent = "Saved.";
  setTimeout(() => {
    saveStatusEl.textContent = "";
  }, 1500);
}

void load();
