export type Strictness = "Gentle" | "Firm" | "Unmovable";

export interface Settings {
  schemaVersion: 1;
  lockoutTime: string; // "23:30" local, daily fixed trigger
  wakeTime: string; // "07:00" — a wake before this re-locks; at/after it is a fresh start
  theme: "ember" | "drift" | "tide";
  countdownLeadsMin: number[]; // [60, 15, 5]; [] disables countdowns
  overridePhrase: string;
  strictness: Strictness;
  gatekeeperModel: "sonnet" | "haiku";
  graceCapsMs: { Gentle: number; Firm: number; Unmovable: number };
  dev: {
    windowedOverlay: boolean;
  };
}

/** Deep-partial helper for mergeSettings' input. */
export type PartialSettings = {
  [K in keyof Settings]?: Settings[K] extends object
    ? Settings[K] extends any[]
      ? Settings[K]
      : Partial<Settings[K]>
    : Settings[K];
};

export const DEFAULTS: Settings = {
  schemaVersion: 1,
  lockoutTime: "23:30",
  wakeTime: "07:00",
  theme: "drift",
  countdownLeadsMin: [60, 15, 5],
  overridePhrase: "let me finish tonight",
  strictness: "Firm",
  gatekeeperModel: "sonnet",
  graceCapsMs: {
    Gentle: 45 * 60_000,
    Firm: 15 * 60_000,
    Unmovable: 5 * 60_000,
  },
  dev: {
    windowedOverlay: false,
  },
};

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && HH_MM_RE.test(value);
}

function isPositiveDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Validates a HH:MM time field, falling back to `fallback` if invalid. */
function mergeTime(value: unknown, fallback: string): string {
  return isValidTime(value) ? value : fallback;
}

/** Validates a positive-duration (ms) field, falling back to `fallback` if invalid. */
function mergeDuration(value: unknown, fallback: number): number {
  return isPositiveDuration(value) ? value : fallback;
}

const THEMES = new Set(["ember", "drift", "tide"]);
const STRICTNESS = new Set(["Gentle", "Firm", "Unmovable"]);
const GATEKEEPER_MODELS = new Set(["sonnet", "haiku"]);

function mergeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback;
}

/**
 * Deep-merges a partial settings object onto DEFAULTS, validating each field.
 * Invalid values (wrong type, malformed HH:MM, non-positive durations) fall
 * back to the corresponding DEFAULTS value rather than throwing — settings
 * persisted by an older/buggy version of the app should never crash startup.
 */
export function mergeSettings(partial: PartialSettings | Record<string, unknown> = {}): Settings {
  const p = (partial ?? {}) as Record<string, any>;
  const graceCapsIn = (p.graceCapsMs ?? {}) as Record<string, any>;
  const devIn = (p.dev ?? {}) as Record<string, any>;

  return {
    schemaVersion: 1,
    lockoutTime: mergeTime(p.lockoutTime, DEFAULTS.lockoutTime),
    wakeTime: mergeTime(p.wakeTime, DEFAULTS.wakeTime),
    theme: mergeEnum(p.theme, THEMES, DEFAULTS.theme),
    countdownLeadsMin: Array.isArray(p.countdownLeadsMin)
      ? p.countdownLeadsMin.filter(
          (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
        )
      : DEFAULTS.countdownLeadsMin,
    overridePhrase:
      typeof p.overridePhrase === "string" && p.overridePhrase.length > 0
        ? p.overridePhrase
        : DEFAULTS.overridePhrase,
    strictness: mergeEnum(p.strictness, STRICTNESS, DEFAULTS.strictness),
    gatekeeperModel: mergeEnum(p.gatekeeperModel, GATEKEEPER_MODELS, DEFAULTS.gatekeeperModel),
    graceCapsMs: {
      Gentle: mergeDuration(graceCapsIn.Gentle, DEFAULTS.graceCapsMs.Gentle),
      Firm: mergeDuration(graceCapsIn.Firm, DEFAULTS.graceCapsMs.Firm),
      Unmovable: mergeDuration(graceCapsIn.Unmovable, DEFAULTS.graceCapsMs.Unmovable),
    },
    dev: {
      windowedOverlay:
        typeof devIn.windowedOverlay === "boolean"
          ? devIn.windowedOverlay
          : DEFAULTS.dev.windowedOverlay,
    },
  };
}
