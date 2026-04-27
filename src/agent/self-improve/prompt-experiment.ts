/** System prompt A/B testing: register variants, pick per session, record evidence with variantId. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendEvidence, readEvidence } from "./evidence.js";
import type { EvidenceOutcome, EvidenceRecord } from "./types.js";

export interface PromptVariant {
  id: string;
  content: string;
}

export interface PromptExperiment {
  name: string;
  variants: PromptVariant[];
  /** ISO 8601 timestamp for when the experiment was registered. */
  registeredAt: string;
  /** Total pickVariant invocations for this experiment. */
  runs: number;
  /** Counts per variant id (for deterministic round-robin in tests). */
  runsByVariant: Record<string, number>;
}

export interface RegisterExperimentOptions {
  name: string;
  variants: PromptVariant[];
  /** Override experiments dir (default ~/.coreline-agent/experiments). */
  rootDir?: string;
}

export interface PickVariantOptions {
  name: string;
  /** Pick strategy: "random" (uniform) or "round-robin". Default: round-robin. */
  strategy?: "random" | "round-robin";
  rootDir?: string;
}

export interface RecordExperimentUseOptions {
  projectId: string;
  experimentName: string;
  variantId: string;
  sessionId: string;
  outcome: EvidenceOutcome;
  rootDir?: string;
}

/** Sanitize experiment name for safe filename use. */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, "_");
  return cleaned.replace(/^\.+/, "").slice(0, 120) || "_unknown";
}

/** Resolve the experiments directory, honouring rootDir override. */
function getExperimentsDir(rootDir?: string): string {
  const base = rootDir ?? join(homedir(), ".coreline-agent");
  return join(base, "experiments");
}

function getExperimentPath(name: string, rootDir?: string): string {
  return join(getExperimentsDir(rootDir), `${sanitizeName(name)}.json`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadExperimentFile(path: string): PromptExperiment | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as PromptExperiment;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.name !== "string" ||
      !Array.isArray(parsed.variants)
    ) {
      return null;
    }
    // Defensive: fill missing fields.
    if (typeof parsed.runs !== "number") parsed.runs = 0;
    if (!parsed.runsByVariant || typeof parsed.runsByVariant !== "object") {
      parsed.runsByVariant = {};
    }
    if (typeof parsed.registeredAt !== "string") {
      parsed.registeredAt = new Date().toISOString();
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveExperiment(experiment: PromptExperiment, rootDir?: string): void {
  const dir = getExperimentsDir(rootDir);
  ensureDir(dir);
  const path = getExperimentPath(experiment.name, rootDir);
  writeFileSync(path, `${JSON.stringify(experiment, null, 2)}\n`, "utf8");
}

/** Register (or overwrite) an experiment by name. Resets run counters. */
export function registerExperiment(
  options: RegisterExperimentOptions,
): PromptExperiment {
  if (!options.name) {
    throw new Error("registerExperiment: name is required");
  }
  if (!Array.isArray(options.variants) || options.variants.length === 0) {
    throw new Error("registerExperiment: at least one variant is required");
  }
  const seen = new Set<string>();
  for (const variant of options.variants) {
    if (!variant || typeof variant.id !== "string" || !variant.id) {
      throw new Error("registerExperiment: each variant must have an id");
    }
    if (typeof variant.content !== "string") {
      throw new Error("registerExperiment: each variant must have string content");
    }
    if (seen.has(variant.id)) {
      throw new Error(
        `registerExperiment: duplicate variant id "${variant.id}"`,
      );
    }
    seen.add(variant.id);
  }
  const runsByVariant: Record<string, number> = {};
  for (const v of options.variants) runsByVariant[v.id] = 0;

  const experiment: PromptExperiment = {
    name: options.name,
    variants: options.variants.map((v) => ({ id: v.id, content: v.content })),
    registeredAt: new Date().toISOString(),
    runs: 0,
    runsByVariant,
  };
  saveExperiment(experiment, options.rootDir);
  return experiment;
}

/** Pick a variant from a registered experiment. Returns null if not found. */
export function pickVariant(options: PickVariantOptions): PromptVariant | null {
  const path = getExperimentPath(options.name, options.rootDir);
  const experiment = loadExperimentFile(path);
  if (!experiment || experiment.variants.length === 0) return null;

  const strategy = options.strategy ?? "round-robin";
  let pickIdx = 0;
  if (strategy === "random") {
    pickIdx = Math.floor(Math.random() * experiment.variants.length);
    if (pickIdx >= experiment.variants.length) {
      pickIdx = experiment.variants.length - 1;
    }
  } else {
    // round-robin: lowest count, tie-break by first occurrence.
    let bestCount = Number.POSITIVE_INFINITY;
    for (let i = 0; i < experiment.variants.length; i++) {
      const id = experiment.variants[i]!.id;
      const count = experiment.runsByVariant[id] ?? 0;
      if (count < bestCount) {
        bestCount = count;
        pickIdx = i;
      }
    }
  }

  const picked = experiment.variants[pickIdx]!;
  experiment.runs += 1;
  experiment.runsByVariant[picked.id] =
    (experiment.runsByVariant[picked.id] ?? 0) + 1;
  try {
    saveExperiment(experiment, options.rootDir);
  } catch {
    // Best-effort persistence.
  }
  return { id: picked.id, content: picked.content };
}

/** List all experiments in the experiments directory. Corrupt files are skipped. */
export function listExperiments(rootDir?: string): PromptExperiment[] {
  const dir = getExperimentsDir(rootDir);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PromptExperiment[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const experiment = loadExperimentFile(join(dir, entry));
    if (experiment) out.push(experiment);
  }
  return out;
}

/** Get a specific experiment by name. Returns null if missing or corrupt. */
export function getExperiment(
  name: string,
  rootDir?: string,
): PromptExperiment | null {
  return loadExperimentFile(getExperimentPath(name, rootDir));
}

/** Delete an experiment file. Returns true if a file was removed. */
export function deleteExperiment(name: string, rootDir?: string): boolean {
  const path = getExperimentPath(name, rootDir);
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Append evidence for an experiment run.
 * Stored under domain="prompt" with id = experimentName and metadata.variantId
 * so that records can be aggregated per-experiment and split by variant.
 * Best-effort: swallows errors.
 */
export function recordExperimentUse(options: RecordExperimentUseOptions): void {
  try {
    const priors = readEvidence(
      options.projectId,
      "prompt",
      options.experimentName,
      {},
      options.rootDir,
    );
    const record: EvidenceRecord = {
      domain: "prompt",
      id: options.experimentName,
      sessionId: options.sessionId,
      iteration: priors.length + 1,
      invokedAt: new Date().toISOString(),
      outcome: options.outcome,
      metadata: { variantId: options.variantId },
    };
    appendEvidence(options.projectId, record, options.rootDir);
  } catch {
    // Best-effort only.
  }
}
