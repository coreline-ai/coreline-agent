/**
 * Decision frontmatter validator (Wave 10 P1 R3).
 *
 * Validates raw frontmatter + parsed body sections into a strongly-typed
 * DecisionRecord. Used by decision-store at read time to silently skip
 * corrupted records (best-effort, non-throwing). Caller logs a warning.
 */

import type { DecisionRecord, DecisionStatus } from "./types.js";

export type ValidationResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: string };

const VALID_DECISION_STATUSES: ReadonlyArray<DecisionStatus> = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
];
const VALID_TIERS: ReadonlyArray<DecisionRecord["tier"]> = ["core", "recall", "archival"];
const DECISION_ID_RE = /^dec-\d{8}-/;

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

export interface DecisionValidatorInput {
  frontmatter: Record<string, unknown>;
  sections: Record<string, unknown>;
}

export function validateDecisionRecord(
  raw: DecisionValidatorInput,
): ValidationResult<DecisionRecord> {
  const fm = raw.frontmatter;
  const sec = raw.sections;

  const id = asString(fm.id);
  if (!id || !DECISION_ID_RE.test(id)) {
    return { ok: false, error: `invalid or missing id: ${JSON.stringify(fm.id)}` };
  }

  const title = asString(fm.title);
  if (!isNonEmptyString(title)) {
    return { ok: false, error: "missing or empty title" };
  }

  const statusRaw = asString(fm.status);
  if (
    !statusRaw ||
    !(VALID_DECISION_STATUSES as ReadonlyArray<string>).includes(statusRaw)
  ) {
    return { ok: false, error: `invalid status: ${JSON.stringify(fm.status)}` };
  }
  const status = statusRaw as DecisionStatus;

  const decidedAt = asString(fm.decidedAt);
  if (!isNonEmptyString(decidedAt)) {
    return { ok: false, error: "missing or empty decidedAt" };
  }
  const validFrom = asString(fm.validFrom);
  if (!isNonEmptyString(validFrom)) {
    return { ok: false, error: "missing or empty validFrom" };
  }
  const recordedAt = asString(fm.recordedAt);
  if (!isNonEmptyString(recordedAt)) {
    return { ok: false, error: "missing or empty recordedAt" };
  }

  const validTo = asString(fm.validTo);

  // Tier: must be valid; otherwise default per status
  let tier: DecisionRecord["tier"];
  const tierRaw = asString(fm.tier);
  if (tierRaw && (VALID_TIERS as ReadonlyArray<string>).includes(tierRaw)) {
    tier = tierRaw as DecisionRecord["tier"];
  } else {
    tier = status === "superseded" || status === "rejected" ? "archival" : "core";
  }

  const source = asString(fm.source) ?? "manual";
  const tags = asStringArray(fm.tags);
  const linkedIncidents = asStringArray(fm.linkedIncidents);

  // Body sections: what/why/how must be non-empty
  const what = asString(sec.what);
  if (!isNonEmptyString(what)) {
    return { ok: false, error: "missing or empty 'what' body section" };
  }
  const why = asString(sec.why);
  if (!isNonEmptyString(why)) {
    return { ok: false, error: "missing or empty 'why' body section" };
  }
  const how = asString(sec.how);
  if (!isNonEmptyString(how)) {
    return { ok: false, error: "missing or empty 'how' body section" };
  }

  const outcome =
    typeof sec.outcome === "string" && sec.outcome.trim().length > 0
      ? sec.outcome
      : undefined;

  const record: DecisionRecord = {
    id,
    title,
    status,
    decidedAt,
    validFrom,
    validTo,
    recordedAt,
    tier,
    source,
    tags,
    linkedIncidents,
    what,
    why,
    how,
    outcome,
  };

  return { ok: true, record };
}
