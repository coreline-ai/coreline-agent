/**
 * Decision Memory Layer (Wave 9 Phase 7) — port of MemKraft decision_store.py.
 *
 * Records product/architectural/operational decisions with bitemporal
 * semantics + bidirectional incident linking. Storage:
 * `<projectMemory>/decisions/dec-{YYYYMMDD}-{slug}.md`.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureDecisionsDir, getDecisionsDir } from "../../config/paths.js";
import { incidentGet, incidentUpdate } from "../incident/incident-store.js";
import { validateDecisionRecord } from "./decision-validator.js";
import type {
  DecisionRecord,
  DecisionRecordOptions,
  DecisionSearchOptions,
  DecisionStatus,
  DecisionUpdate,
} from "./types.js";

const STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "accepted",
  "superseded",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function makeSlug(what: string): string {
  const base = what.toLowerCase().slice(0, 30);
  const sanitized = base.replace(/[^\w-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "decision";
}

function makeDecisionId(what: string, decidedAt: string): string {
  const d = new Date(decidedAt);
  const safe = isNaN(d.getTime()) ? new Date() : d;
  const date = formatDate(safe);
  const slug = makeSlug(what);
  return `dec-${date}-${slug}`;
}

function decisionFilePath(projectId: string, id: string, rootDir?: string): string {
  return join(getDecisionsDir(projectId, rootDir), `${id}.md`);
}

function validateStatus(s: string): DecisionStatus {
  if (!STATUSES.has(s)) {
    throw new Error(`status must be one of proposed|accepted|superseded|rejected, got '${s}'`);
  }
  return s as DecisionStatus;
}

function decideTier(
  status: DecisionStatus,
  explicit: "core" | "recall" | "archival" | undefined,
): "core" | "recall" | "archival" {
  if (explicit) return explicit;
  return status === "superseded" || status === "rejected" ? "archival" : "core";
}

function nonempty(value: string | undefined, field: string): string {
  if (value === undefined || value === null || !String(value).trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return String(value).trim();
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
      heading = t.startsWith("Decision:") ? t.slice("Decision:".length).trim() : t;
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

  const out: string[] = [`---`, fm, `---`, ``, `# Decision: ${heading}`, ``];
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

function sectionText(lines: string[]): string {
  return lines.join("\n").trim();
}

function linkedIncidentsFromLines(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*-\s+/, "").trim())
    .filter((l) => l.length > 0);
}

function linkedIncidentsToLines(items: string[]): string[] {
  return items.map((i) => `- ${i}`);
}

function buildRecordFromDoc(parsed: ParsedDoc): DecisionRecord {
  const fm = parsed.frontmatter;
  const id = String(fm.id ?? "");
  const title = String(fm.title ?? parsed.heading ?? "");
  const status: DecisionStatus = STATUSES.has(String(fm.status))
    ? (String(fm.status) as DecisionStatus)
    : "accepted";
  const tier = ["core", "recall", "archival"].includes(String(fm.tier))
    ? (String(fm.tier) as DecisionRecord["tier"])
    : status === "superseded" || status === "rejected"
      ? "archival"
      : "core";

  const what = sectionText(parsed.sections.get("What") ?? []);
  const why = sectionText(parsed.sections.get("Why") ?? []);
  const how = sectionText(parsed.sections.get("How") ?? []);
  const outcomeText = sectionText(parsed.sections.get("Outcome") ?? []);
  const outcome =
    outcomeText && outcomeText !== "(pending)" ? outcomeText : undefined;
  const linkedIncidents = linkedIncidentsFromLines(
    parsed.sections.get("Linked Incidents") ?? [],
  );

  return {
    id,
    title,
    status,
    decidedAt: String(fm.decidedAt ?? ""),
    validFrom: String(fm.validFrom ?? fm.decidedAt ?? ""),
    validTo: typeof fm.validTo === "string" ? fm.validTo : undefined,
    recordedAt: String(fm.recordedAt ?? ""),
    tier,
    source: String(fm.source ?? "manual"),
    tags: Array.isArray(fm.tags) ? fm.tags.map((x) => String(x)) : [],
    linkedIncidents:
      Array.isArray(fm.linkedIncidents) && fm.linkedIncidents.length > 0
        ? fm.linkedIncidents.map((x) => String(x))
        : linkedIncidents,
    what,
    why,
    how,
    outcome,
  };
}

function recordToFrontmatter(rec: DecisionRecord): Record<string, unknown> {
  return {
    id: rec.id,
    type: "decision",
    title: rec.title,
    status: rec.status,
    decidedAt: rec.decidedAt,
    validFrom: rec.validFrom,
    validTo: rec.validTo,
    recordedAt: rec.recordedAt,
    tier: rec.tier,
    source: rec.source,
    tags: rec.tags,
    linkedIncidents: rec.linkedIncidents,
  };
}

function recordToSections(rec: DecisionRecord): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  sections.set("What", rec.what.split(/\r?\n/));
  sections.set("Why", rec.why.split(/\r?\n/));
  sections.set("How", rec.how.split(/\r?\n/));
  sections.set(
    "Outcome",
    rec.outcome && rec.outcome.trim() ? rec.outcome.split(/\r?\n/) : ["(pending)"],
  );
  sections.set("Linked Incidents", linkedIncidentsToLines(rec.linkedIncidents));
  return sections;
}

function writeRecord(projectId: string, rec: DecisionRecord, rootDir?: string): void {
  ensureDecisionsDir(projectId, rootDir);
  const path = decisionFilePath(projectId, rec.id, rootDir);
  const content = serializeDoc(recordToFrontmatter(rec), rec.title, recordToSections(rec));
  writeFileSync(path, content, "utf-8");
}

/**
 * Run the type-specific validator on a parsed doc + built record.
 * Returns the validated record on success, or null + warns on failure.
 * (Wave 10 P1 R3)
 */
function validateOrWarn(
  parsed: ParsedDoc,
  rec: DecisionRecord,
  fileLabel: string,
): DecisionRecord | null {
  const result = validateDecisionRecord({
    frontmatter: parsed.frontmatter,
    sections: {
      what: rec.what,
      why: rec.why,
      how: rec.how,
      outcome: rec.outcome,
    },
  });
  if (!result.ok) {
    console.warn(
      `[decision-store] invalid frontmatter for ${fileLabel}: ${result.error} (skipping)`,
    );
    return null;
  }
  return result.record;
}

function readRecord(projectId: string, id: string, rootDir?: string): DecisionRecord | null {
  const path = decisionFilePath(projectId, id, rootDir);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = parseDoc(content);
    const rec = buildRecordFromDoc(parsed);
    return validateOrWarn(parsed, rec, id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bidirectional linking
// ---------------------------------------------------------------------------

function linkIncidentBackref(
  projectId: string,
  incidentId: string,
  decisionId: string,
  rootDir?: string,
): void {
  const inc = incidentGet(projectId, incidentId, rootDir);
  if (!inc) {
    // D19: missing incident — silent skip with warning
    console.warn(`[decision] linked incident not found: ${incidentId}`);
    return;
  }
  const tag = `decision: ${decisionId}`;
  if (inc.related.includes(tag)) return;
  try {
    incidentUpdate(projectId, incidentId, { related: [tag] }, rootDir);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decisionRecord(
  projectId: string,
  what: string,
  why: string,
  how: string,
  options?: DecisionRecordOptions,
  rootDir?: string,
): string {
  const whatClean = nonempty(what, "what");
  const whyClean = nonempty(why, "why");
  const howClean = nonempty(how, "how");

  const status = validateStatus(options?.status ?? "accepted");
  const decidedAt = options?.decidedAt ?? nowIso();
  const now = nowIso();

  // Generate unique id (suffix on collision).
  let id = makeDecisionId(whatClean, decidedAt);
  const baseId = id;
  let suffix = 2;
  while (existsSync(decisionFilePath(projectId, id, rootDir))) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const tier = decideTier(status, options?.tier);

  const rec: DecisionRecord = {
    id,
    title: whatClean,
    status,
    decidedAt,
    validFrom: options?.validFrom ?? decidedAt,
    validTo: options?.validTo,
    recordedAt: now,
    tier,
    source: options?.source ?? "manual",
    tags: [...(options?.tags ?? [])],
    linkedIncidents: [...(options?.linkedIncidents ?? [])],
    what: whatClean,
    why: whyClean,
    how: howClean,
    outcome: options?.outcome && options.outcome.trim() ? options.outcome.trim() : undefined,
  };

  writeRecord(projectId, rec, rootDir);

  // Bidirectional link — best-effort, D19 (missing/archival incidents).
  for (const incId of rec.linkedIncidents) {
    try {
      linkIncidentBackref(projectId, incId, id, rootDir);
    } catch {
      // best-effort
    }
  }

  return id;
}

export function decisionUpdate(
  projectId: string,
  decisionId: string,
  updates: DecisionUpdate,
  rootDir?: string,
): DecisionRecord {
  const existing = readRecord(projectId, decisionId, rootDir);
  if (!existing) {
    throw new Error(`decision not found: ${decisionId}`);
  }

  const now = nowIso();
  const next: DecisionRecord = { ...existing };

  if (updates.status !== undefined) {
    next.status = validateStatus(updates.status);
    if (next.status === "superseded" || next.status === "rejected") {
      next.tier = "archival";
      next.validTo = now;
    }
  }

  if (updates.outcome !== undefined && updates.outcome.trim().length > 0) {
    const line = `- [${now}] ${updates.outcome.trim()}`;
    next.outcome = next.outcome ? `${next.outcome}\n${line}` : line;
  }

  if (updates.appendWhy && updates.appendWhy.trim().length > 0) {
    const line = `- [${now}] ${updates.appendWhy.trim()}`;
    next.why = next.why ? `${next.why}\n${line}` : line;
  }

  if (updates.appendHow && updates.appendHow.trim().length > 0) {
    const line = `- [${now}] ${updates.appendHow.trim()}`;
    next.how = next.how ? `${next.how}\n${line}` : line;
  }

  if (updates.tags && updates.tags.length > 0) {
    const seen = new Set(next.tags);
    for (const t of updates.tags) {
      if (!seen.has(t)) {
        next.tags.push(t);
        seen.add(t);
      }
    }
  }

  if (updates.linkedIncidents && updates.linkedIncidents.length > 0) {
    const seen = new Set(next.linkedIncidents);
    const newOnes: string[] = [];
    for (const iid of updates.linkedIncidents) {
      if (!seen.has(iid)) {
        next.linkedIncidents.push(iid);
        seen.add(iid);
        newOnes.push(iid);
      }
    }
    next.recordedAt = now;
    writeRecord(projectId, next, rootDir);
    for (const iid of newOnes) {
      try {
        linkIncidentBackref(projectId, iid, decisionId, rootDir);
      } catch {
        // best-effort
      }
    }
    return next;
  }

  next.recordedAt = now;
  writeRecord(projectId, next, rootDir);
  return next;
}

export function decisionGet(
  projectId: string,
  decisionId: string,
  rootDir?: string,
): DecisionRecord | null {
  return readRecord(projectId, decisionId, rootDir);
}

export function decisionSearch(
  projectId: string,
  options?: DecisionSearchOptions,
  rootDir?: string,
): DecisionRecord[] {
  const dir = getDecisionsDir(projectId, rootDir);
  if (!existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "_index.md");
  } catch {
    return [];
  }

  const opts = options ?? {};
  if (opts.status !== undefined) validateStatus(opts.status);

  const tfFrom = opts.timeframe?.[0];
  const tfTo = opts.timeframe?.[1];
  const q = (opts.query ?? "").toLowerCase().trim();

  const results: DecisionRecord[] = [];
  for (const file of entries) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    let rec: DecisionRecord;
    let parsed: ParsedDoc;
    try {
      parsed = parseDoc(content);
      rec = buildRecordFromDoc(parsed);
    } catch {
      continue;
    }
    const validated = validateOrWarn(parsed, rec, file);
    if (!validated) continue;
    rec = validated;

    if (opts.status && rec.status !== opts.status) continue;
    if (opts.tag && !rec.tags.includes(opts.tag)) continue;
    if (opts.linkedIncident && !rec.linkedIncidents.includes(opts.linkedIncident)) continue;

    const decided = rec.decidedAt ?? "";
    if (tfFrom && decided < tfFrom) continue;
    if (tfTo && decided > tfTo) continue;

    if (q) {
      const haystack = [
        rec.title,
        rec.what,
        rec.why,
        rec.how,
        rec.outcome ?? "",
        ...rec.tags,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }

    results.push(rec);
  }

  results.sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0));

  const limit = opts.limit ?? 20;
  if (limit > 0 && results.length > limit) {
    return results.slice(0, limit);
  }
  return results;
}
