/**
 * Incident frontmatter validator (Wave 10 P1 R3).
 *
 * Validates raw frontmatter + parsed body sections into a strongly-typed
 * IncidentRecord. Used by incident-store at read time to silently skip
 * corrupted records (best-effort, non-throwing). Caller logs a warning.
 */

import { narrowSeverity } from "./severity-utils.js";
import type {
  IncidentEvidence,
  IncidentHypothesis,
  IncidentRecord,
  IncidentStatus,
} from "./types.js";

export type ValidationResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: string };

const INCIDENT_ID_RE = /^inc-\d{8}-\d{6}-[a-f0-9]{8}(?:-\d+)?$/;
const VALID_TIERS: ReadonlyArray<IncidentRecord["tier"]> = ["core", "recall", "archival"];
const VALID_HYP_STATUS: ReadonlyArray<IncidentHypothesis["status"]> = [
  "testing",
  "rejected",
  "confirmed",
];

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

/**
 * Raw input shape for the validator.
 *
 * `sections` is expected to be a record with already-extracted typed fields:
 *   - `symptoms`: string[]
 *   - `evidence`: IncidentEvidence[] (loose shape ok)
 *   - `hypotheses`: IncidentHypothesis[] (loose shape ok)
 *   - `resolution`: string | undefined
 *   - `related`: string[]
 */
export interface IncidentValidatorInput {
  frontmatter: Record<string, unknown>;
  sections: Record<string, unknown>;
}

export function validateIncidentRecord(
  raw: IncidentValidatorInput,
): ValidationResult<IncidentRecord> {
  const fm = raw.frontmatter;
  const sec = raw.sections;

  // Required: id
  const id = asString(fm.id);
  if (!id || !INCIDENT_ID_RE.test(id)) {
    return { ok: false, error: `invalid or missing id: ${JSON.stringify(fm.id)}` };
  }

  // Required: title
  const title = asString(fm.title);
  if (!isNonEmptyString(title)) {
    return { ok: false, error: "missing or empty title" };
  }

  // Required: severity (narrowable)
  const severity = narrowSeverity(fm.severity);
  if (!severity) {
    return { ok: false, error: `invalid severity: ${JSON.stringify(fm.severity)}` };
  }

  // Required: status
  const statusRaw = asString(fm.status);
  if (statusRaw !== "open" && statusRaw !== "resolved") {
    return { ok: false, error: `invalid status: ${JSON.stringify(fm.status)}` };
  }
  const status: IncidentStatus = statusRaw;

  // Required: detectedAt, validFrom, recordedAt (non-empty strings)
  const detectedAt = asString(fm.detectedAt);
  if (!isNonEmptyString(detectedAt)) {
    return { ok: false, error: "missing or empty detectedAt" };
  }
  const validFrom = asString(fm.validFrom);
  if (!isNonEmptyString(validFrom)) {
    return { ok: false, error: "missing or empty validFrom" };
  }
  const recordedAt = asString(fm.recordedAt);
  if (!isNonEmptyString(recordedAt)) {
    return { ok: false, error: "missing or empty recordedAt" };
  }

  // Optional: resolvedAt, validTo
  const resolvedAt = asString(fm.resolvedAt);
  const validTo = asString(fm.validTo);

  // Optional: tier (default per status)
  let tier: IncidentRecord["tier"];
  const tierRaw = asString(fm.tier);
  if (tierRaw && (VALID_TIERS as ReadonlyArray<string>).includes(tierRaw)) {
    tier = tierRaw as IncidentRecord["tier"];
  } else {
    tier = status === "resolved" ? "archival" : "core";
  }

  const source = asString(fm.source) ?? "manual";
  const affected = asStringArray(fm.affected);
  const tags = asStringArray(fm.tags);
  const toolUseId = asString(fm.toolUseId);
  const turnIndex = typeof fm.turnIndex === "number" ? fm.turnIndex : undefined;

  // Sections: symptoms (default [])
  const symptoms = asStringArray(sec.symptoms);

  // Evidence: filter invalid entries (best-effort)
  const evidence: IncidentEvidence[] = [];
  if (Array.isArray(sec.evidence)) {
    for (const item of sec.evidence) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).type === "string" &&
        typeof (item as Record<string, unknown>).value === "string" &&
        typeof (item as Record<string, unknown>).collectedAt === "string"
      ) {
        const obj = item as Record<string, unknown>;
        evidence.push({
          type: obj.type as string,
          value: obj.value as string,
          collectedAt: obj.collectedAt as string,
        });
      }
    }
  }

  // Hypotheses: filter invalid entries
  const hypotheses: IncidentHypothesis[] = [];
  if (Array.isArray(sec.hypotheses)) {
    for (const item of sec.hypotheses) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).text === "string" &&
        typeof (item as Record<string, unknown>).status === "string" &&
        typeof (item as Record<string, unknown>).notedAt === "string" &&
        (VALID_HYP_STATUS as ReadonlyArray<string>).includes(
          (item as Record<string, unknown>).status as string,
        )
      ) {
        const obj = item as Record<string, unknown>;
        hypotheses.push({
          text: obj.text as string,
          status: obj.status as IncidentHypothesis["status"],
          notedAt: obj.notedAt as string,
        });
      }
    }
  }

  const resolution = typeof sec.resolution === "string" ? sec.resolution : undefined;
  const related = asStringArray(sec.related);

  const record: IncidentRecord = {
    id,
    title,
    severity,
    status,
    detectedAt,
    resolvedAt,
    validFrom,
    validTo,
    recordedAt,
    tier,
    source,
    affected,
    tags,
    toolUseId,
    turnIndex,
    symptoms,
    evidence,
    hypotheses,
    resolution,
    related,
  };

  return { ok: true, record };
}
