/**
 * Append-only JSONL evidence store for self-improvement records.
 * Best-effort I/O: write failures return {recorded:false, error} — never throw.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceAppendResult, EvidenceDomain, EvidenceRecord } from "./types.js";
import {
  getPromptEvidenceDir,
  getSkillEvidenceDir,
  getSubagentEvidenceDir,
} from "../../config/paths.js";

/** Resolve the on-disk directory for a given evidence domain. */
function getEvidenceDir(projectId: string, domain: EvidenceDomain, rootDir?: string): string {
  switch (domain) {
    case "skill":
      return getSkillEvidenceDir(projectId, rootDir);
    case "subagent":
      return getSubagentEvidenceDir(projectId, rootDir);
    case "prompt":
      return getPromptEvidenceDir(projectId, rootDir);
    case "plan-iteration":
      // Plan iterations share the skill-evidence directory with a stable id prefix.
      // This keeps the on-disk surface small and avoids adding another dir in paths.ts.
      return join(getSkillEvidenceDir(projectId, rootDir), "_plan");
  }
}

/** Sanitize the evidence id for use as a filename: keep [A-Za-z0-9._-] only. */
function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^\w.-]+/g, "_");
  // Strip any leading dots that could collide with dot-files or traversal.
  return cleaned.replace(/^\.+/, "").slice(0, 120) || "_unknown";
}

/** Append a single evidence record. Creates directory and file as needed. */
export function appendEvidence(
  projectId: string,
  record: EvidenceRecord,
  rootDir?: string,
): EvidenceAppendResult {
  if (!projectId) {
    return { recorded: false, error: "projectId is required" };
  }
  try {
    const dir = getEvidenceDir(projectId, record.domain, rootDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filename = `${sanitizeId(record.id)}.jsonl`;
    const path = join(dir, filename);
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return { recorded: true };
  } catch (err) {
    return {
      recorded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read evidence records for a given domain+id. Parses JSONL line-by-line.
 * Corrupted lines are silently skipped. Optionally filter by age.
 */
export function readEvidence(
  projectId: string,
  domain: EvidenceDomain,
  id: string,
  options: { sinceDays?: number } = {},
  rootDir?: string,
): EvidenceRecord[] {
  if (!projectId) return [];
  try {
    const dir = getEvidenceDir(projectId, domain, rootDir);
    const path = join(dir, `${sanitizeId(id)}.jsonl`);
    if (!existsSync(path)) return [];

    const raw = readFileSync(path, "utf8");
    const cutoffMs =
      typeof options.sinceDays === "number" && options.sinceDays > 0
        ? Date.now() - options.sinceDays * 86_400_000
        : null;

    const results: EvidenceRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as EvidenceRecord;
        if (cutoffMs !== null) {
          const ts = Date.parse(parsed.invokedAt);
          if (!Number.isFinite(ts) || ts < cutoffMs) continue;
        }
        results.push(parsed);
      } catch {
        // Silently skip corrupted lines.
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** List all evidence ids (filenames without .jsonl) for a domain. */
export function listEvidenceIds(
  projectId: string,
  domain: EvidenceDomain,
  rootDir?: string,
): string[] {
  if (!projectId) return [];
  try {
    const dir = getEvidenceDir(projectId, domain, rootDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}
