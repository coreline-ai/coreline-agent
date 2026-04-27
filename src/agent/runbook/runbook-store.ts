/**
 * Runbook Memory store (Wave 9 Phase 8) — port of MemKraft runbook.py.
 *
 * Stores symptom→steps remediation patterns as MD frontmatter docs at
 * `<projectMemory>/runbooks/rb-{hash8}.md`. Provides upsert-by-pattern
 * `runbookAdd`, similarity-scored `runbookMatch` (regex-aware), `runbookGet`,
 * and `runbookList`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureRunbooksDir, getRunbooksDir } from "../../config/paths.js";
import { patternSimilarity, scoreMatch } from "./pattern-matcher.js";
import { validateRunbookRecord } from "./runbook-validator.js";
import type {
  RunbookAddOptions,
  RunbookMatch,
  RunbookMatchOptions,
  RunbookRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function makeRunbookId(): string {
  return `rb-${randomBytes(4).toString("hex")}`;
}

function runbookFilePath(projectId: string, id: string, rootDir?: string): string {
  return join(getRunbooksDir(projectId, rootDir), `${id}.md`);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  heading: string;
  sections: Map<string, string[]>;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseDoc(content: string): ParsedDoc {
  const m = content.match(FM_RE);
  let frontmatter: Record<string, unknown> = {};
  let body = content;
  if (m) {
    try {
      const parsed = parseYaml(m[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      frontmatter = {};
    }
    body = m[2] ?? "";
  }

  const lines = body.split(/\r?\n/);
  let heading = "";
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      const t = h1[1]!.trim();
      heading = t.startsWith("Runbook:") ? t.slice("Runbook:".length).trim() : t;
      currentSection = null;
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      currentSection = h2[1]!.trim();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }
    if (currentSection !== null) {
      const arr = sections.get(currentSection)!;
      if (line.trim() === "" && arr.length === 0) continue;
      arr.push(line);
    }
  }

  for (const [k, arr] of sections.entries()) {
    while (arr.length > 0 && arr[arr.length - 1]!.trim() === "") arr.pop();
    sections.set(k, arr);
  }

  return { frontmatter, heading, sections };
}

function serializeDoc(
  frontmatter: Record<string, unknown>,
  heading: string,
  sections: Map<string, string[]>,
): string {
  const filtered = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== undefined),
  );
  const fm = stringifyYaml(filtered).trimEnd();

  const out: string[] = [`---`, fm, `---`, ``, `# Runbook: ${heading}`, ``];
  for (const [name, lines] of sections.entries()) {
    out.push(`## ${name}`);
    if (lines.length === 0) {
      out.push("");
    } else {
      for (const l of lines) out.push(l);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function stepsFromLines(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*-\s+/, "").replace(/^\s*\d+\.\s+/, "").trim())
    .filter((l) => l.length > 0);
}

function stepsToLines(steps: string[]): string[] {
  return steps.map((s, i) => `${i + 1}. ${s}`);
}

function singleLineSection(lines: string[]): string | undefined {
  const txt = lines.join("\n").trim();
  if (!txt || txt === "(unknown)" || txt === "(none)") return undefined;
  return txt;
}

// ---------------------------------------------------------------------------
// Record builder
// ---------------------------------------------------------------------------

function buildRecordFromDoc(parsed: ParsedDoc, fallbackId: string): RunbookRecord {
  const fm = parsed.frontmatter;
  const id = String(fm.id ?? fallbackId);
  const pattern = String(fm.pattern ?? parsed.heading ?? "");
  const tier = ["core", "recall", "archival"].includes(String(fm.tier))
    ? (String(fm.tier) as RunbookRecord["tier"])
    : "recall";

  let confidence = 0.5;
  const rawConf = fm.confidence;
  if (typeof rawConf === "number" && !Number.isNaN(rawConf)) confidence = rawConf;
  else if (typeof rawConf === "string") {
    const parsedConf = Number(rawConf);
    if (!Number.isNaN(parsedConf)) confidence = parsedConf;
  }

  const usageCountRaw = fm.usageCount;
  const usageCount =
    typeof usageCountRaw === "number" && Number.isFinite(usageCountRaw)
      ? Math.trunc(usageCountRaw)
      : 0;

  const sourceIncidents = Array.isArray(fm.sourceIncidents)
    ? (fm.sourceIncidents as unknown[]).map((x) => String(x))
    : [];
  const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).map((x) => String(x)) : [];

  const steps = stepsFromLines(parsed.sections.get("Steps") ?? []);
  const symptomTxt = singleLineSection(parsed.sections.get("Symptom") ?? []);
  const cause = singleLineSection(parsed.sections.get("Cause") ?? []);
  const evidenceCmd = singleLineSection(parsed.sections.get("Evidence Command") ?? []);
  const fixAction = singleLineSection(parsed.sections.get("Fix Action") ?? []);
  const verification = singleLineSection(parsed.sections.get("Verification") ?? []);

  return {
    id,
    type: "runbook",
    pattern,
    confidence,
    usageCount,
    sourceIncidents,
    createdAt: String(fm.createdAt ?? ""),
    updatedAt: String(fm.updatedAt ?? ""),
    lastMatched: typeof fm.lastMatched === "string" ? fm.lastMatched : undefined,
    tier,
    tags,
    symptom: symptomTxt ?? pattern,
    cause,
    steps,
    evidenceCmd,
    fixAction,
    verification,
  };
}

function recordToFrontmatter(rec: RunbookRecord): Record<string, unknown> {
  return {
    id: rec.id,
    type: "runbook",
    pattern: rec.pattern,
    confidence: rec.confidence,
    usageCount: rec.usageCount,
    sourceIncidents: rec.sourceIncidents,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastMatched: rec.lastMatched,
    tier: rec.tier,
    tags: rec.tags,
  };
}

function recordToSections(rec: RunbookRecord): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  sections.set("Symptom", [rec.pattern]);
  sections.set("Cause", [rec.cause ?? "(unknown)"]);
  sections.set("Steps", stepsToLines(rec.steps));
  sections.set("Evidence Command", [rec.evidenceCmd ?? "(none)"]);
  sections.set("Fix Action", [rec.fixAction ?? "(none)"]);
  sections.set("Verification", [rec.verification ?? "(none)"]);
  return sections;
}

function writeRecord(projectId: string, rec: RunbookRecord, rootDir?: string): void {
  ensureRunbooksDir(projectId, rootDir);
  const path = runbookFilePath(projectId, rec.id, rootDir);
  const content = serializeDoc(recordToFrontmatter(rec), rec.pattern, recordToSections(rec));
  writeFileSync(path, content, "utf-8");
}

/**
 * Run the type-specific validator on a parsed doc + built record.
 * Returns the validated record on success, or null + warns on failure.
 * (Wave 10 P1 R3)
 */
function validateOrWarn(
  parsed: ParsedDoc,
  rec: RunbookRecord,
  fileLabel: string,
): RunbookRecord | null {
  const result = validateRunbookRecord({
    frontmatter: parsed.frontmatter,
    sections: {
      steps: rec.steps,
      symptom: rec.symptom,
      cause: rec.cause,
      evidenceCmd: rec.evidenceCmd,
      fixAction: rec.fixAction,
      verification: rec.verification,
    },
  });
  if (!result.ok) {
    console.warn(
      `[runbook-store] invalid frontmatter for ${fileLabel}: ${result.error} (skipping)`,
    );
    return null;
  }
  return result.record;
}

function readRecord(projectId: string, id: string, rootDir?: string): RunbookRecord | null {
  const path = runbookFilePath(projectId, id, rootDir);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = parseDoc(content);
    const rec = buildRecordFromDoc(parsed, id);
    return validateOrWarn(parsed, rec, id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a runbook (or upsert if a runbook with the same `pattern` exists).
 * Returns the (existing or new) runbook id.
 */
export function runbookAdd(
  projectId: string,
  pattern: string,
  steps: string[],
  options?: RunbookAddOptions,
  rootDir?: string,
): string {
  const trimmedPattern = (pattern ?? "").trim();
  if (!trimmedPattern) {
    throw new Error("pattern must be a non-empty string");
  }
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    throw new Error("steps must be a non-empty list of strings");
  }
  const cleanedSteps = steps.map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (cleanedSteps.length === 0) {
    throw new Error("steps must be a non-empty list of strings");
  }

  const confidenceRaw = options?.confidence ?? 0.5;
  const confidence = Number(confidenceRaw);
  if (!Number.isFinite(confidence)) {
    throw new Error("confidence must be a float in [0, 1]");
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error("confidence must be in [0, 1]");
  }

  const incomingSources: string[] = [];
  for (const s of options?.sourceIncidents ?? []) {
    if (s && !incomingSources.includes(s)) incomingSources.push(s);
  }
  if (options?.sourceIncidentId && !incomingSources.includes(options.sourceIncidentId)) {
    incomingSources.push(options.sourceIncidentId);
  }
  const incomingTags: string[] = [];
  for (const t of options?.tags ?? []) {
    if (t && !incomingTags.includes(t)) incomingTags.push(t);
  }

  // Look for an existing runbook with the same pattern (upsert by pattern).
  const existing = findByPattern(projectId, trimmedPattern, rootDir);
  const now = nowIso();

  if (existing) {
    const mergedSources = [...existing.sourceIncidents];
    for (const s of incomingSources) {
      if (!mergedSources.includes(s)) mergedSources.push(s);
    }

    const mergedSteps = [...existing.steps];
    for (const s of cleanedSteps) {
      if (!mergedSteps.includes(s)) mergedSteps.push(s);
    }

    const mergedTags = [...existing.tags];
    for (const t of incomingTags) {
      if (!mergedTags.includes(t)) mergedTags.push(t);
    }

    const next: RunbookRecord = {
      ...existing,
      pattern: trimmedPattern,
      confidence: Math.max(existing.confidence, confidence),
      // usageCount preserved (no reset, no bump on upsert per MemKraft semantics)
      usageCount: existing.usageCount,
      sourceIncidents: mergedSources,
      updatedAt: now,
      tags: mergedTags,
      symptom: trimmedPattern,
      cause: existing.cause ?? options?.cause?.trim(),
      steps: mergedSteps,
      evidenceCmd: existing.evidenceCmd ?? options?.evidenceCmd?.trim(),
      fixAction: existing.fixAction ?? options?.fixAction?.trim(),
      verification: existing.verification ?? options?.verification?.trim(),
    };
    writeRecord(projectId, next, rootDir);
    return existing.id;
  }

  // Create new — generate fresh id (collision-safe).
  let id = makeRunbookId();
  while (existsSync(runbookFilePath(projectId, id, rootDir))) {
    id = makeRunbookId();
  }

  const rec: RunbookRecord = {
    id,
    type: "runbook",
    pattern: trimmedPattern,
    confidence,
    usageCount: 0,
    sourceIncidents: incomingSources,
    createdAt: now,
    updatedAt: now,
    lastMatched: undefined,
    tier: "recall",
    tags: incomingTags,
    symptom: trimmedPattern,
    cause: options?.cause?.trim() || undefined,
    steps: cleanedSteps,
    evidenceCmd: options?.evidenceCmd?.trim() || undefined,
    fixAction: options?.fixAction?.trim() || undefined,
    verification: options?.verification?.trim() || undefined,
  };
  writeRecord(projectId, rec, rootDir);
  return id;
}

function findByPattern(
  projectId: string,
  pattern: string,
  rootDir?: string,
): RunbookRecord | null {
  const list = runbookList(projectId, rootDir);
  for (const rb of list) {
    if (rb.pattern === pattern) return rb;
  }
  return null;
}

/**
 * Match a symptom string against stored runbooks.
 * Returns top-N by score desc; on `touch:true` (default) bumps usageCount,
 * lastMatched, and confidence (+0.02 capped at 1.0) on every returned match.
 */
export function runbookMatch(
  projectId: string,
  symptom: string,
  options?: RunbookMatchOptions,
  rootDir?: string,
): RunbookMatch[] {
  const trimmed = (symptom ?? "").trim();
  if (!trimmed) return [];

  const minConfidence = options?.minConfidence ?? 0.0;
  const minScore = options?.minScore ?? 0.2;
  const limit = options?.limit ?? 5;
  const touch = options?.touch !== false;

  const all = runbookList(projectId, rootDir);
  const matches: RunbookMatch[] = [];
  for (const rb of all) {
    if (rb.confidence < minConfidence) continue;
    const { sim, isRegex } = patternSimilarity(rb.pattern, trimmed);
    const score = scoreMatch(sim, rb.confidence);
    if (score < minScore) continue;
    matches.push({
      runbook: rb,
      similarity: sim,
      score,
      isRegexMatch: isRegex,
    });
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.runbook.confidence - a.runbook.confidence;
  });

  // Apply touch reinforcement (persist back to disk + reflect in returned record)
  if (touch && matches.length > 0) {
    const now = nowIso();
    for (const m of matches) {
      const updated: RunbookRecord = {
        ...m.runbook,
        usageCount: m.runbook.usageCount + 1,
        lastMatched: now,
        confidence: Math.min(1.0, m.runbook.confidence + 0.02),
        updatedAt: now,
      };
      try {
        writeRecord(projectId, updated, rootDir);
        m.runbook = updated;
        // recompute score with bumped confidence? MemKraft persists but doesn't re-score.
      } catch {
        // ignore persist failure — still return original match
      }
    }
  }

  if (limit && limit > 0) {
    return matches.slice(0, limit);
  }
  return matches;
}

/** Read a runbook by id; returns null if not found. */
export function runbookGet(
  projectId: string,
  runbookId: string,
  rootDir?: string,
): RunbookRecord | null {
  return readRecord(projectId, runbookId, rootDir);
}

/** List all runbooks for a project (unsorted; callers sort as needed). */
export function runbookList(projectId: string, rootDir?: string): RunbookRecord[] {
  const dir = getRunbooksDir(projectId, rootDir);
  if (!existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: RunbookRecord[] = [];
  for (const file of entries) {
    const id = file.replace(/\.md$/, "");
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    try {
      const parsed = parseDoc(content);
      const rec = buildRecordFromDoc(parsed, id);
      const validated = validateOrWarn(parsed, rec, file);
      if (validated && validated.id) out.push(validated);
    } catch {
      continue;
    }
  }
  return out;
}
