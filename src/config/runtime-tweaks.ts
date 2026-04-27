/**
 * RuntimeTweaks — session-local tweak registry for operator-facing knobs.
 *
 * This module is intentionally independent from the TUI and agent loop so it
 * can be unit tested in isolation and reused later by higher-level wiring.
 */

export type RuntimeTweakKey =
  | "maxTurns"
  | "temperature"
  | "budget"
  | "autoSummary"
  | "showReasoning"
  | "maxResultChars";

export type TweakableKey = RuntimeTweakKey;

export interface RuntimeTweaksValues {
  maxTurns: number;
  temperature?: number;
  budget?: number;
  autoSummary: boolean;
  showReasoning: boolean;
  maxResultChars?: number;
}

export type RuntimeTweakValue = RuntimeTweaksValues[RuntimeTweakKey];
export type TweakValue = RuntimeTweakValue;

export interface TweakChangeRecord {
  id: number;
  key: RuntimeTweakKey;
  source: "set" | "reset";
  rawValue?: unknown;
  previousValue?: RuntimeTweakValue;
  nextValue?: RuntimeTweakValue;
  changed: boolean;
  createdAt: string;
}

export interface RuntimeTweaksSnapshot {
  defaults: RuntimeTweaksValues;
  values: RuntimeTweaksValues;
  history: TweakChangeRecord[];
}

export type TweakSnapshot = RuntimeTweaksSnapshot;

export interface RuntimeTweaksOptions {
  defaults?: Partial<RuntimeTweaksValues>;
  onChange?: (record: TweakChangeRecord, snapshot: RuntimeTweaksSnapshot) => void;
  now?: () => Date;
}

export class RuntimeTweakError extends Error {
  constructor(
    message: string,
    public readonly key?: string,
  ) {
    super(message);
    this.name = "RuntimeTweakError";
  }
}

export const DEFAULT_RUNTIME_TWEAKS: RuntimeTweaksValues = {
  maxTurns: 50,
  temperature: undefined,
  budget: undefined,
  autoSummary: true,
  showReasoning: true,
  maxResultChars: undefined,
};

const NUMBER_TWEAK_KEYS: ReadonlySet<RuntimeTweakKey> = new Set([
  "maxTurns",
  "temperature",
  "budget",
  "maxResultChars",
]);

const BOOLEAN_TWEAK_KEYS: ReadonlySet<RuntimeTweakKey> = new Set([
  "autoSummary",
  "showReasoning",
]);

const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 200;
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const BUDGET_MIN = 0;
const MAX_RESULT_CHARS_MIN = 1_000;
const MAX_RESULT_CHARS_MAX = 500_000;

function isRuntimeTweakKey(value: string): value is RuntimeTweakKey {
  return value === "maxTurns"
    || value === "temperature"
    || value === "budget"
    || value === "autoSummary"
    || value === "showReasoning"
    || value === "maxResultChars";
}

export function parseRuntimeTweakKey(value: string): RuntimeTweakKey {
  const trimmed = value.trim();
  if (!isRuntimeTweakKey(trimmed)) {
    throw new RuntimeTweakError(`Unknown runtime tweak key: ${value}`);
  }
  return trimmed;
}

function parseBooleanValue(key: RuntimeTweakKey, value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new RuntimeTweakError(`Invalid boolean value for ${key}: ${String(value)}`, key);
}

function parseNumberValue(key: RuntimeTweakKey, value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeTweakError(`Invalid number value for ${key}: ${String(value)}`, key);
    }
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new RuntimeTweakError(`Invalid number value for ${key}: ${String(value)}`, key);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new RuntimeTweakError(`Invalid number value for ${key}: ${String(value)}`, key);
    }
    return parsed;
  }

  throw new RuntimeTweakError(`Invalid number value for ${key}: ${String(value)}`, key);
}

export function parseRuntimeTweakValue(key: RuntimeTweakKey, value: unknown): RuntimeTweakValue {
  if (NUMBER_TWEAK_KEYS.has(key)) {
    const parsed = parseNumberValue(key, value);
    switch (key) {
      case "maxTurns":
        if (!Number.isInteger(parsed) || parsed < MAX_TURNS_MIN || parsed > MAX_TURNS_MAX) {
          throw new RuntimeTweakError(`maxTurns must be an integer between ${MAX_TURNS_MIN} and ${MAX_TURNS_MAX}.`, key);
        }
        return parsed;
      case "budget":
        if (parsed < BUDGET_MIN) {
          throw new RuntimeTweakError(`budget must be greater than or equal to ${BUDGET_MIN}.`, key);
        }
        return parsed;
      case "temperature":
        if (parsed < TEMPERATURE_MIN || parsed > TEMPERATURE_MAX) {
          throw new RuntimeTweakError(`temperature must be between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}.`, key);
        }
        return parsed;
      case "maxResultChars":
        if (!Number.isInteger(parsed) || parsed < MAX_RESULT_CHARS_MIN || parsed > MAX_RESULT_CHARS_MAX) {
          throw new RuntimeTweakError(`maxResultChars must be an integer between ${MAX_RESULT_CHARS_MIN} and ${MAX_RESULT_CHARS_MAX}.`, key);
        }
        return parsed;
    }
  }

  if (BOOLEAN_TWEAK_KEYS.has(key)) {
    return parseBooleanValue(key, value);
  }

  throw new RuntimeTweakError(`Unknown runtime tweak key: ${key}`, key);
}

function cloneValues(values: RuntimeTweaksValues): RuntimeTweaksValues {
  return {
    maxTurns: values.maxTurns,
    temperature: values.temperature,
    budget: values.budget,
    autoSummary: values.autoSummary,
    showReasoning: values.showReasoning,
    maxResultChars: values.maxResultChars,
  };
}

function formatBoolean(value: boolean): string {
  return value ? "on" : "off";
}

function formatNumeric(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Number.isFinite(value) ? String(value) : "0";
}

function formatBudget(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export class RuntimeTweaks {
  private readonly defaults: RuntimeTweaksValues;
  private readonly values: RuntimeTweaksValues;
  private readonly history: TweakChangeRecord[] = [];
  private readonly onChange?: (record: TweakChangeRecord, snapshot: RuntimeTweaksSnapshot) => void;
  private readonly now: () => Date;
  private nextId = 1;

  constructor(options: RuntimeTweaksOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onChange = options.onChange;
    this.defaults = this.normalizeDefaults(options.defaults);
    this.values = cloneValues(this.defaults);
  }

  get(key: RuntimeTweakKey): RuntimeTweakValue {
    return this.values[key];
  }

  getAll(): RuntimeTweaksValues {
    return cloneValues(this.values);
  }

  set(key: string, rawValue: unknown): TweakChangeRecord {
    const normalizedKey = parseRuntimeTweakKey(key);
    const nextValue = parseRuntimeTweakValue(normalizedKey, rawValue);
    return this.apply(normalizedKey, nextValue, "set", rawValue);
  }

  reset(key: string): TweakChangeRecord {
    const normalizedKey = parseRuntimeTweakKey(key);
    return this.apply(normalizedKey, this.defaults[normalizedKey], "reset");
  }

  snapshot(): RuntimeTweaksSnapshot {
    return {
      defaults: cloneValues(this.defaults),
      values: cloneValues(this.values),
      history: this.history.map((record) => ({ ...record })),
    };
  }

  formatStatus(): string {
    const overrides: string[] = [];
    for (const key of [
      "maxTurns",
      "temperature",
      "budget",
      "autoSummary",
      "showReasoning",
      "maxResultChars",
    ] as const) {
      const value = this.values[key];
      const defaultValue = this.defaults[key];
      if (Object.is(value, defaultValue)) continue;

      if (key === "budget" && typeof value === "number") {
        overrides.push(`${key}=${formatBudget(value)}`);
      } else if (typeof value === "boolean") {
        overrides.push(`${key}=${formatBoolean(value)}`);
      } else if (typeof value === "number") {
        overrides.push(`${key}=${formatNumeric(value)}`);
      } else if (value === undefined) {
        overrides.push(`${key}=default`);
      }
    }

    if (overrides.length === 0) {
      return "runtime tweaks: default";
    }

    return `runtime tweaks: ${overrides.join(", ")}`;
  }

  private normalizeDefaults(defaults: Partial<RuntimeTweaksValues> = {}): RuntimeTweaksValues {
    const merged: RuntimeTweaksValues = cloneValues(DEFAULT_RUNTIME_TWEAKS);
    for (const key of Object.keys(defaults) as RuntimeTweakKey[]) {
      if (!isRuntimeTweakKey(key)) {
        throw new RuntimeTweakError(`Unknown runtime tweak key: ${key}`, key);
      }
      const value = defaults[key];
      if (value === undefined) continue;
      const parsed = parseRuntimeTweakValue(key, value);
      switch (key) {
        case "maxTurns":
          merged.maxTurns = parsed as number;
          break;
        case "temperature":
          merged.temperature = parsed as number | undefined;
          break;
        case "budget":
          merged.budget = parsed as number | undefined;
          break;
        case "autoSummary":
          merged.autoSummary = parsed as boolean;
          break;
        case "showReasoning":
          merged.showReasoning = parsed as boolean;
          break;
        case "maxResultChars":
          merged.maxResultChars = parsed as number | undefined;
          break;
      }
    }
    return merged;
  }

  private apply(
    key: RuntimeTweakKey,
    nextValue: RuntimeTweakValue,
    source: TweakChangeRecord["source"],
    rawValue?: unknown,
  ): TweakChangeRecord {
    const previousValue = this.values[key];
    const changed = !Object.is(previousValue, nextValue);
    if (changed) {
      this.assignValue(key, nextValue);
    }

    const record: TweakChangeRecord = {
      id: this.nextId++,
      key,
      source,
      rawValue,
      previousValue,
      nextValue,
      changed,
      createdAt: this.now().toISOString(),
    };

    this.history.push(record);
    if (changed && this.onChange) {
      this.onChange(record, this.snapshot());
    }

    return { ...record };
  }

  private assignValue(key: RuntimeTweakKey, value: RuntimeTweakValue): void {
    switch (key) {
      case "maxTurns":
        this.values.maxTurns = value as number;
        return;
      case "temperature":
        this.values.temperature = value as number | undefined;
        return;
      case "budget":
        this.values.budget = value as number | undefined;
        return;
      case "autoSummary":
        this.values.autoSummary = value as boolean;
        return;
      case "showReasoning":
        this.values.showReasoning = value as boolean;
        return;
      case "maxResultChars":
        this.values.maxResultChars = value as number | undefined;
        return;
    }
  }
}
