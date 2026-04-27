/**
 * Runbook frontmatter validator (Wave 10 P1 R3).
 *
 * Validates raw frontmatter + parsed body sections into a strongly-typed
 * RunbookRecord. Used by runbook-store at read time to silently skip
 * corrupted records (best-effort, non-throwing). Caller logs a warning.
 */

import type { RunbookRecord } from "./types.js";

export type ValidationResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: string };

const RUNBOOK_ID_RE = /^rb-[a-f0-9]{8}$/;
const VALID_TIERS: ReadonlyArray<RunbookRecord["tier"]> = ["core", "recall", "archival"];

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export interface RunbookValidatorInput {
  frontmatter: Record<string, unknown>;
  sections: Record<string, unknown>;
}

export function validateRunbookRecord(
  raw: RunbookValidatorInput,
): ValidationResult<RunbookRecord> {
  const fm = raw.frontmatter;
  const sec = raw.sections;

  const id = asString(fm.id);
  if (!id || !RUNBOOK_ID_RE.test(id)) {
    return { ok: false, error: `invalid or missing id: ${JSON.stringify(fm.id)}` };
  }

  const pattern = asString(fm.pattern);
  if (!isNonEmptyString(pattern)) {
    return { ok: false, error: "missing or empty pattern" };
  }

  // confidence: number in [0,1]
  let confidence: number;
  const rawConf = fm.confidence;
  if (typeof rawConf === "number" && Number.isFinite(rawConf)) {
    confidence = rawConf;
  } else if (typeof rawConf === "string" && rawConf.trim().length > 0) {
    const parsed = Number(rawConf);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: `invalid confidence: ${JSON.stringify(rawConf)}` };
    }
    confidence = parsed;
  } else {
    return { ok: false, error: `missing or invalid confidence: ${JSON.stringify(rawConf)}` };
  }
  if (confidence < 0 || confidence > 1) {
    return { ok: false, error: `confidence out of range [0,1]: ${confidence}` };
  }

  // usageCount: integer >= 0
  const rawUsage = fm.usageCount;
  if (typeof rawUsage !== "number" || !Number.isFinite(rawUsage)) {
    return { ok: false, error: `invalid usageCount: ${JSON.stringify(rawUsage)}` };
  }
  if (rawUsage < 0 || !Number.isInteger(rawUsage)) {
    return { ok: false, error: `usageCount must be a non-negative integer: ${rawUsage}` };
  }
  const usageCount = rawUsage;

  const tierRaw = asString(fm.tier);
  if (!tierRaw || !(VALID_TIERS as ReadonlyArray<string>).includes(tierRaw)) {
    return { ok: false, error: `invalid tier: ${JSON.stringify(fm.tier)}` };
  }
  const tier = tierRaw as RunbookRecord["tier"];

  const createdAt = asString(fm.createdAt);
  if (!isNonEmptyString(createdAt)) {
    return { ok: false, error: "missing or empty createdAt" };
  }
  const updatedAt = asString(fm.updatedAt);
  if (!isNonEmptyString(updatedAt)) {
    return { ok: false, error: "missing or empty updatedAt" };
  }

  const lastMatched = asString(fm.lastMatched);
  const sourceIncidents = asStringArray(fm.sourceIncidents);
  const tags = asStringArray(fm.tags);

  // steps: required non-empty array of strings
  const steps = asStringArray(sec.steps);
  if (steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }

  const symptom =
    typeof sec.symptom === "string" && sec.symptom.trim().length > 0
      ? sec.symptom
      : pattern;
  const cause = typeof sec.cause === "string" && sec.cause.trim().length > 0 ? sec.cause : undefined;
  const evidenceCmd =
    typeof sec.evidenceCmd === "string" && sec.evidenceCmd.trim().length > 0
      ? sec.evidenceCmd
      : undefined;
  const fixAction =
    typeof sec.fixAction === "string" && sec.fixAction.trim().length > 0
      ? sec.fixAction
      : undefined;
  const verification =
    typeof sec.verification === "string" && sec.verification.trim().length > 0
      ? sec.verification
      : undefined;

  const record: RunbookRecord = {
    id,
    type: "runbook",
    pattern,
    confidence,
    usageCount,
    sourceIncidents,
    createdAt,
    updatedAt,
    lastMatched,
    tier,
    tags,
    symptom,
    cause,
    steps,
    evidenceCmd,
    fixAction,
    verification,
  };

  return { ok: true, record };
}
