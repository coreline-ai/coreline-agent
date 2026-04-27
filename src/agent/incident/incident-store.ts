/**
 * Incident Memory Layer (Wave 8 Phase 6) — port of MemKraft incident.py.
 *
 * Records operational incidents as first-class memory with bitemporal
 * semantics, tier auto-assignment (open→core, resolved→archival),
 * and evidence-backed structure.
 *
 * Storage: `<projectMemory>/incidents/inc-<YYYYMMDD>-<HHMMSS>-<hash8>.md`.
 * Frontmatter contains scalar fields; body sections (Symptoms, Evidence,
 * Hypotheses, Resolution, Related) are markdown lists.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureIncidentsDir, getIncidentsDir } from "../../config/paths.js";
import { DEFAULT_INCIDENT_SEVERITY } from "../../memory/constants.js";
import { validateIncidentRecord } from "./incident-validator.js";
import { narrowSeverity } from "./severity-utils.js";
import type {
  IncidentEvidence,
  IncidentHypothesis,
  IncidentRecord,
  IncidentRecordOptions,
  IncidentSearchOptions,
  IncidentSeverity,
  IncidentStatus,
  IncidentUpdate,
} from "./types.js";

const SEVERITIES: ReadonlySet<string> = new Set(["low", "medium", "high", "critical"]);
const STATUSES: ReadonlySet<string> = new Set(["open", "resolved"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatIdTimestamp(d: Date): { date: string; time: string } {
  const date = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return { date, time };
}

function makeIncidentId(detectedAt: string): string {
  const d = new Date(detectedAt);
  const safe = isNaN(d.getTime()) ? new Date() : d;
  const { date, time } = formatIdTimestamp(safe);
  const hash = randomBytes(4).toString("hex");
  return `inc-${date}-${time}-${hash}`;
}

/**
 * Coerce a raw severity input to a valid IncidentSeverity.
 *
 * - undefined → DEFAULT_INCIDENT_SEVERITY (caller's default-flow)
 * - valid string → narrowed value
 * - invalid string → warn + fallback to DEFAULT_INCIDENT_SEVERITY
 *
 * This replaces the previous throw-on-invalid behavior so user input
 * boundaries (CLI, tool input) gracefully fall back rather than crash.
 */
function coerceSeverity(raw: unknown): IncidentSeverity {
  if (raw === undefined) return DEFAULT_INCIDENT_SEVERITY;
  const narrowed = narrowSeverity(raw);
  if (narrowed) return narrowed;
  console.warn(
    `[incident] invalid severity '${String(raw)}', falling back to '${DEFAULT_INCIDENT_SEVERITY}'`,
  );
  return DEFAULT_INCIDENT_SEVERITY;
}

function incidentFilePath(projectId: string, id: string, rootDir?: string): string {
  return join(getIncidentsDir(projectId, rootDir), `${id}.md`);
}

function decideTier(
  status: IncidentStatus,
  explicit: "core" | "recall" | "archival" | undefined,
): "core" | "recall" | "archival" {
  if (explicit) return explicit;
  return status === "resolved" ? "archival" : "core";
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

  // Parse heading + sections from body
  const lines = body.split(/\r?\n/);
  let heading = "";
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      const t = h1[1]!.trim();
      heading = t.startsWith("Incident:") ? t.slice("Incident:".length).trim() : t;
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
      // strip trailing empty leading lines
      if (line.trim() === "" && arr.length === 0) continue;
      arr.push(line);
    }
  }

  // Trim trailing blank lines per section
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
  // Drop undefined fields; preserve insertion order via filtering.
  const filtered = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== undefined),
  );
  const fm = stringifyYaml(filtered).trimEnd();

  const out: string[] = [`---`, fm, `---`, ``, `# Incident: ${heading}`, ``];
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

function symptomsFromLines(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*-\s+/, "").trim())
    .filter((l) => l.length > 0);
}

function symptomsToLines(items: string[]): string[] {
  return items.map((s) => `- ${s}`);
}

function evidenceFromLines(lines: string[]): IncidentEvidence[] {
  const out: IncidentEvidence[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*-\s+/, "").trim();
    if (!line) continue;
    // Format: "[<type>] (<collectedAt>) <value>"
    const m = line.match(/^\[([^\]]+)\]\s*(?:\(([^)]+)\)\s*)?(.*)$/);
    if (m) {
      out.push({
        type: m[1]!.trim(),
        collectedAt: (m[2] ?? "").trim(),
        value: (m[3] ?? "").trim(),
      });
    } else {
      out.push({ type: "note", collectedAt: "", value: line });
    }
  }
  return out;
}

function evidenceToLines(items: IncidentEvidence[]): string[] {
  return items.map((e) => {
    const t = e.type || "note";
    const ts = e.collectedAt ? ` (${e.collectedAt})` : "";
    return `- [${t}]${ts} ${e.value}`.replace(/\s+$/, "");
  });
}

function hypothesesFromLines(lines: string[]): IncidentHypothesis[] {
  const out: IncidentHypothesis[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*-\s+/, "").trim();
    if (!line) continue;
    // Format: "[<status>] <text>" or "[<status> @ <ts>] <text>"
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      const tagPart = m[1]!.trim();
      const text = (m[2] ?? "").trim();
      const tagMatch = tagPart.match(/^(testing|rejected|confirmed)(?:\s*@\s*(.+))?$/);
      if (tagMatch) {
        out.push({
          status: tagMatch[1] as IncidentHypothesis["status"],
          notedAt: (tagMatch[2] ?? "").trim(),
          text,
        });
        continue;
      }
    }
    out.push({ status: "testing", notedAt: "", text: line });
  }
  return out;
}

function hypothesesToLines(items: IncidentHypothesis[]): string[] {
  return items.map((h) => {
    const tag = h.notedAt ? `${h.status} @ ${h.notedAt}` : h.status;
    return `- [${tag}] ${h.text}`;
  });
}

function relatedFromLines(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*-\s+/, "").trim())
    .filter((l) => l.length > 0);
}

function relatedToLines(items: string[]): string[] {
  return items.map((r) => `- ${r}`);
}

function resolutionFromLines(lines: string[]): string | undefined {
  const txt = lines.join("\n").trim();
  return txt.length > 0 ? txt : undefined;
}

function resolutionToLines(text: string | undefined): string[] {
  if (!text) return [];
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Core record builder
// ---------------------------------------------------------------------------

function buildRecordFromDoc(parsed: ParsedDoc): IncidentRecord {
  const fm = parsed.frontmatter;
  const id = String(fm.id ?? "");
  const title = String(fm.title ?? parsed.heading ?? "");
  const severity = SEVERITIES.has(String(fm.severity))
    ? (String(fm.severity) as IncidentSeverity)
    : "medium";
  const status = STATUSES.has(String(fm.status))
    ? (String(fm.status) as IncidentStatus)
    : "open";
  const tier = ["core", "recall", "archival"].includes(String(fm.tier))
    ? (String(fm.tier) as IncidentRecord["tier"])
    : status === "resolved"
      ? "archival"
      : "core";

  const symptoms = symptomsFromLines(parsed.sections.get("Symptoms") ?? []);
  const evidence = evidenceFromLines(parsed.sections.get("Evidence") ?? []);
  const hypotheses = hypothesesFromLines(parsed.sections.get("Hypotheses") ?? []);
  const resolution = resolutionFromLines(parsed.sections.get("Resolution") ?? []);
  const related = relatedFromLines(parsed.sections.get("Related") ?? []);

  return {
    id,
    title,
    severity,
    status,
    detectedAt: String(fm.detectedAt ?? ""),
    resolvedAt: typeof fm.resolvedAt === "string" ? fm.resolvedAt : undefined,
    validFrom: String(fm.validFrom ?? fm.detectedAt ?? ""),
    validTo: typeof fm.validTo === "string" ? fm.validTo : undefined,
    recordedAt: String(fm.recordedAt ?? ""),
    tier,
    source: String(fm.source ?? "manual"),
    affected: Array.isArray(fm.affected) ? fm.affected.map((x) => String(x)) : [],
    tags: Array.isArray(fm.tags) ? fm.tags.map((x) => String(x)) : [],
    toolUseId: typeof fm.toolUseId === "string" ? fm.toolUseId : undefined,
    turnIndex: typeof fm.turnIndex === "number" ? fm.turnIndex : undefined,
    symptoms,
    evidence,
    hypotheses,
    resolution,
    related,
  };
}

function recordToFrontmatter(rec: IncidentRecord): Record<string, unknown> {
  return {
    id: rec.id,
    type: "incident",
    title: rec.title,
    severity: rec.severity,
    status: rec.status,
    detectedAt: rec.detectedAt,
    resolvedAt: rec.resolvedAt,
    validFrom: rec.validFrom,
    validTo: rec.validTo,
    recordedAt: rec.recordedAt,
    tier: rec.tier,
    source: rec.source,
    affected: rec.affected,
    tags: rec.tags,
    toolUseId: rec.toolUseId,
    turnIndex: rec.turnIndex,
  };
}

function recordToSections(rec: IncidentRecord): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  sections.set("Symptoms", symptomsToLines(rec.symptoms));
  sections.set("Evidence", evidenceToLines(rec.evidence));
  sections.set("Hypotheses", hypothesesToLines(rec.hypotheses));
  sections.set("Resolution", resolutionToLines(rec.resolution));
  sections.set("Related", relatedToLines(rec.related));
  return sections;
}

function writeRecord(projectId: string, rec: IncidentRecord, rootDir?: string): void {
  ensureIncidentsDir(projectId, rootDir);
  const path = incidentFilePath(projectId, rec.id, rootDir);
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
  rec: IncidentRecord,
  fileLabel: string,
): IncidentRecord | null {
  const result = validateIncidentRecord({
    frontmatter: parsed.frontmatter,
    sections: {
      symptoms: rec.symptoms,
      evidence: rec.evidence,
      hypotheses: rec.hypotheses,
      resolution: rec.resolution,
      related: rec.related,
    },
  });
  if (!result.ok) {
    console.warn(
      `[incident-store] invalid frontmatter for ${fileLabel}: ${result.error} (skipping)`,
    );
    return null;
  }
  return result.record;
}

function readRecord(projectId: string, id: string, rootDir?: string): IncidentRecord | null {
  const path = incidentFilePath(projectId, id, rootDir);
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Records an incident; auto-tier (open → core, resolved → archival).
 * Returns the new incident id.
 */
export function incidentRecord(
  projectId: string,
  title: string,
  symptoms: string[],
  options?: IncidentRecordOptions,
  rootDir?: string,
): string {
  if (!title || !title.trim()) {
    throw new Error("title must be a non-empty string");
  }
  if (!symptoms || symptoms.length === 0) {
    throw new Error("symptoms must be a non-empty list");
  }

  const severity = coerceSeverity(options?.severity);
  const detectedAt = options?.detectedAt ?? nowIso();
  const now = nowIso();

  const resolved =
    options?.resolution !== undefined && options.resolution.trim().length > 0;
  const status: IncidentStatus = resolved ? "resolved" : "open";
  const tier = decideTier(status, options?.tier);

  // Generate unique id (collision-resistant via 4-byte hash; suffix on conflict).
  let id = makeIncidentId(detectedAt);
  let suffix = 2;
  while (existsSync(incidentFilePath(projectId, id, rootDir))) {
    id = `${makeIncidentId(detectedAt)}-${suffix}`;
    suffix += 1;
  }

  const rec: IncidentRecord = {
    id,
    title: title.trim(),
    severity,
    status,
    detectedAt,
    resolvedAt: resolved ? now : undefined,
    validFrom: detectedAt,
    validTo: resolved ? now : undefined,
    recordedAt: now,
    tier,
    source: options?.source ?? "manual",
    affected: [...(options?.affected ?? [])],
    tags: [...(options?.tags ?? [])],
    toolUseId: options?.toolUseId,
    turnIndex: options?.turnIndex,
    symptoms: [...symptoms],
    evidence: [...(options?.evidence ?? [])],
    hypotheses: (options?.hypothesis ?? []).map((text) => ({
      text,
      status: "testing" as const,
      notedAt: now,
    })),
    resolution: resolved ? options!.resolution!.trim() : undefined,
    related: [],
  };

  writeRecord(projectId, rec, rootDir);
  return id;
}

/** Update an incident in-place (best-effort dedup; auto-tier on resolution). */
export function incidentUpdate(
  projectId: string,
  incidentId: string,
  updates: IncidentUpdate,
  rootDir?: string,
): IncidentRecord {
  const existing = readRecord(projectId, incidentId, rootDir);
  if (!existing) {
    throw new Error(`incident not found: ${incidentId}`);
  }

  const now = nowIso();
  const next: IncidentRecord = { ...existing };

  if (updates.severity !== undefined) {
    next.severity = coerceSeverity(updates.severity);
  }

  if (updates.addSymptoms && updates.addSymptoms.length > 0) {
    const seen = new Set(next.symptoms);
    for (const s of updates.addSymptoms) {
      if (!seen.has(s)) {
        next.symptoms.push(s);
        seen.add(s);
      }
    }
  }

  if (updates.addEvidence && updates.addEvidence.length > 0) {
    next.evidence = [...next.evidence, ...updates.addEvidence];
  }

  if (updates.addHypothesis && updates.addHypothesis.length > 0) {
    for (const h of updates.addHypothesis) {
      next.hypotheses.push({ text: h, status: "testing", notedAt: now });
    }
  }

  if (updates.rejectHypothesis && updates.rejectHypothesis.length > 0) {
    const rejectSet = new Set(updates.rejectHypothesis);
    let matched = new Set<string>();
    next.hypotheses = next.hypotheses.map((h) => {
      for (const target of rejectSet) {
        if (h.text.includes(target)) {
          matched.add(target);
          return { ...h, status: "rejected" as const, notedAt: now };
        }
      }
      return h;
    });
    for (const target of rejectSet) {
      if (!matched.has(target)) {
        next.hypotheses.push({ text: target, status: "rejected", notedAt: now });
      }
    }
  }

  if (updates.confirmHypothesis && updates.confirmHypothesis.length > 0) {
    const confirmSet = new Set(updates.confirmHypothesis);
    let matched = new Set<string>();
    next.hypotheses = next.hypotheses.map((h) => {
      for (const target of confirmSet) {
        if (h.text.includes(target)) {
          matched.add(target);
          return { ...h, status: "confirmed" as const, notedAt: now };
        }
      }
      return h;
    });
    for (const target of confirmSet) {
      if (!matched.has(target)) {
        next.hypotheses.push({ text: target, status: "confirmed", notedAt: now });
      }
    }
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

  if (updates.affected && updates.affected.length > 0) {
    const seen = new Set(next.affected);
    for (const a of updates.affected) {
      if (!seen.has(a)) {
        next.affected.push(a);
        seen.add(a);
      }
    }
  }

  if (updates.related && updates.related.length > 0) {
    const seen = new Set(next.related);
    for (const r of updates.related) {
      if (!seen.has(r)) {
        next.related.push(r);
        seen.add(r);
      }
    }
  }

  // Resolution / status transitions
  let willResolve = false;
  if (updates.resolution !== undefined && updates.resolution.trim().length > 0) {
    const trimmed = updates.resolution.trim();
    next.resolution = next.resolution ? `${next.resolution}\n${trimmed}` : trimmed;
    if (updates.resolved !== false) {
      willResolve = true;
    }
  }
  if (updates.resolved === true) willResolve = true;
  if (updates.resolved === false) {
    next.status = "open";
    next.resolvedAt = undefined;
    next.validTo = undefined;
    if (next.tier === "archival") next.tier = "core";
  }

  if (willResolve) {
    next.status = "resolved";
    next.resolvedAt = now;
    next.validTo = now;
    next.tier = "archival";
  }

  next.recordedAt = now;

  writeRecord(projectId, next, rootDir);
  return next;
}

/** Read an incident; returns null if not found. */
export function incidentGet(
  projectId: string,
  incidentId: string,
  rootDir?: string,
): IncidentRecord | null {
  return readRecord(projectId, incidentId, rootDir);
}

/** Search incidents by filters. Sorted by detectedAt desc; default limit 20. */
export function incidentSearch(
  projectId: string,
  options?: IncidentSearchOptions,
  rootDir?: string,
): IncidentRecord[] {
  const dir = getIncidentsDir(projectId, rootDir);
  if (!existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const opts = options ?? {};

  // Resolve status from `resolved` shortcut.
  let statusFilter: IncidentStatus | undefined = opts.status;
  if (opts.resolved === true && !statusFilter) statusFilter = "resolved";
  if (opts.resolved === false && !statusFilter) statusFilter = "open";

  const tfFrom = opts.timeframe?.[0];
  const tfTo = opts.timeframe?.[1];
  const q = (opts.query ?? "").toLowerCase().trim();

  const results: IncidentRecord[] = [];
  for (const file of entries) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    let rec: IncidentRecord;
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

    if (opts.severity && rec.severity !== opts.severity) continue;
    if (statusFilter && rec.status !== statusFilter) continue;
    if (opts.affected && !rec.affected.includes(opts.affected)) continue;

    const detected = rec.detectedAt ?? "";
    if (tfFrom && detected < tfFrom) continue;
    if (tfTo && detected > tfTo) continue;

    if (q) {
      const haystack = [
        rec.title,
        ...rec.symptoms,
        ...rec.hypotheses.map((h) => h.text),
        ...rec.tags,
        ...rec.evidence.map((e) => `${e.type} ${e.value}`),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }

    results.push(rec);
  }

  results.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));

  const limit = opts.limit ?? 20;
  if (limit > 0 && results.length > limit) {
    return results.slice(0, limit);
  }
  return results;
}
