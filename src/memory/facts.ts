/**
 * Bitemporal Fact Layer — Wave 7 Phase 1 (port of MemKraft bitemporal.py).
 *
 * Stores facts in `<memoryDir>/facts/<entity-slug>.md` with inline markers
 * encoding both `valid_time` and `recorded_at`:
 *
 *   # Entity: Simon
 *
 *   - role: CEO of Hashed <!-- valid:[2020-03-01..) recorded:2026-04-17T00:30 -->
 *   - role: CTO <!-- valid:[2018-01-01..2020-02-29] recorded:2024-05-10T14:22 -->
 *
 * Empty `from` (after `[`) means open-start. Empty `to` (before `]` or `)`)
 * means open-end (still valid).
 *
 * Best-effort I/O: write failures return `{ written: false, error }`, never throw.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureFactsDir, getFactsDir } from "../config/paths.js";
import type { FactRecord, FactWriteResult } from "./facts-types.js";
import type { ProjectMemoryCore } from "./types.js";

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Bullet line regex. Captures key, value, validFrom (vfrom), validTo (vto),
 * and recordedAt (rec). Closing bracket may be `]` (closed) or `)` (open-end).
 */
const LINE_RE =
  /^\s*-\s*(?<key>[^:]+?):\s*(?<value>.*?)\s*<!--\s*valid:\[(?<vfrom>[^.\]\)]*)\.\.(?<vto>[^\]\)]*)[\]\)]\s+recorded:(?<rec>[^\s>]+)\s*-->\s*$/;

function normaliseDate(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim();
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (lower === "now" || lower === "none") return undefined;
  return v;
}

function nowIso(): string {
  // YYYY-MM-DDTHH:MM (matching MemKraft format).
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function todayIso(): string {
  return nowIso().split("T")[0]!;
}

function formatInterval(validFrom: string | undefined, validTo: string | undefined): string {
  const vf = validFrom ?? "";
  const vt = validTo ?? "";
  // Open-ended upper bound rendered as `[from..)` for readability.
  if (vt) return `[${vf}..${vt}]`;
  return `[${vf}..)`;
}

function formatLine(
  key: string,
  value: string,
  validFrom: string | undefined,
  validTo: string | undefined,
  recordedAt: string | undefined,
): string {
  const interval = formatInterval(validFrom, validTo);
  const rec = recordedAt ?? nowIso();
  return `- ${key}: ${value} <!-- valid:${interval} recorded:${rec} -->`;
}

function parseLine(line: string): FactRecord | null {
  const m = LINE_RE.exec(line);
  if (!m || !m.groups) return null;
  const g = m.groups;
  const validFrom = g["vfrom"]!.trim() || undefined;
  const validTo = g["vto"]!.trim() || undefined;
  return {
    key: g["key"]!.trim(),
    value: g["value"]!.trim(),
    validFrom,
    validTo,
    recordedAt: g["rec"]!.trim(),
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Slugify entity name for use as a filename stem. */
function slugifyEntity(entity: string): string {
  const trimmed = entity.trim();
  if (!trimmed) throw new Error("entity must be a non-empty string");
  // Replace anything that isn't a word char or hyphen with underscore.
  return trimmed.replace(/[^\w-]/g, "_");
}

/** Resolve entity fact-file path (does not create the file/dir). */
function factFile(projectMemory: ProjectMemoryCore, entity: string): string {
  const factsDir = getFactsDir(projectMemoryRootId(projectMemory), projectMemoryRoot(projectMemory));
  return join(factsDir, `${slugifyEntity(entity)}.md`);
}

/**
 * Extract projectId from ProjectMemoryCore. Path helpers expect a projectId
 * + rootDir, but the core only exposes `projectId` and `memoryDir`. We derive
 * rootDir by walking up from `memoryDir` (which is `<root>/projects/<id>/memory`).
 */
function projectMemoryRootId(projectMemory: ProjectMemoryCore): string {
  return projectMemory.projectId;
}

function projectMemoryRoot(projectMemory: ProjectMemoryCore): string {
  // memoryDir = <rootDir>/projects/<projectId>/memory
  // → rootDir = dirname(dirname(dirname(memoryDir)))
  return dirname(dirname(dirname(projectMemory.memoryDir)));
}

function ensureHeader(path: string, entity: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, `# Entity: ${entity}\n\n`, "utf-8");
  }
}

function readFactsRaw(projectMemory: ProjectMemoryCore, entity: string): FactRecord[] {
  const path = factFile(projectMemory, entity);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: FactRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Add a fact to entity's facts.md file. Best-effort (never throws on I/O). */
export function factAdd(
  projectMemory: ProjectMemoryCore,
  entity: string,
  key: string,
  value: string,
  opts?: { validFrom?: string; validTo?: string; recordedAt?: string },
): FactWriteResult {
  if (!entity || !entity.trim()) {
    return { written: false, error: "entity must be a non-empty string" };
  }
  if (!key || !key.trim()) {
    return { written: false, error: "key must be a non-empty string" };
  }
  if (value === null || value === undefined) {
    return { written: false, error: "value must not be null/undefined" };
  }

  const vf = normaliseDate(opts?.validFrom);
  const vt = normaliseDate(opts?.validTo);
  const rec = normaliseDate(opts?.recordedAt) ?? nowIso();

  if (vf && vt && vf > vt) {
    return {
      written: false,
      error: `validFrom (${vf}) must be <= validTo (${vt})`,
    };
  }

  try {
    ensureFactsDir(projectMemoryRootId(projectMemory), projectMemoryRoot(projectMemory));
    const path = factFile(projectMemory, entity);
    // Make sure parent dir exists (paranoia — ensureFactsDir already did it).
    const parent = dirname(path);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    ensureHeader(path, entity);
    const line = formatLine(key.trim(), String(value).trim(), vf, vt, rec);
    appendFileSync(path, line + "\n", "utf-8");
    return { written: true, filePath: path };
  } catch (err) {
    return { written: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get the most-recently-recorded fact valid at `asOf` (default today).
 *
 * Algorithm (MemKraft compat):
 * 1. Read all facts for entity+key.
 * 2. Filter to those whose [validFrom..validTo] interval contains asOf
 *    (treat undefined bounds as ±infinity).
 * 3. Among matches, return the one with the greatest recordedAt.
 * 4. If none match, return null.
 */
export function factAt(
  projectMemory: ProjectMemoryCore,
  entity: string,
  key: string,
  opts?: { asOf?: string },
): FactRecord | null {
  const asOf = normaliseDate(opts?.asOf) ?? todayIso();
  const candidates = readFactsRaw(projectMemory, entity).filter(
    (f) =>
      f.key === key &&
      (f.validFrom === undefined || f.validFrom <= asOf) &&
      (f.validTo === undefined || asOf <= f.validTo),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
  return candidates[0]!;
}

/**
 * All facts for entity (and optional key) sorted by recordedAt **descending**.
 *
 * NOTE: The plan requires desc order (TC-1.5). MemKraft Python defaults to
 * ascending; we deviate intentionally to match the spec for this port.
 */
export function factHistory(
  projectMemory: ProjectMemoryCore,
  entity: string,
  key?: string,
): FactRecord[] {
  let facts = readFactsRaw(projectMemory, entity);
  if (key !== undefined) facts = facts.filter((f) => f.key === key);
  facts.sort((a, b) => {
    if (a.recordedAt < b.recordedAt) return 1;
    if (a.recordedAt > b.recordedAt) return -1;
    // tiebreaker: validFrom ascending (stable)
    const af = a.validFrom ?? "";
    const bf = b.validFrom ?? "";
    if (af < bf) return -1;
    if (af > bf) return 1;
    return 0;
  });
  return facts;
}

/**
 * Close open intervals for the key by recording invalid_at. Returns the count
 * of facts modified. Append-only history: existing lines are NOT deleted —
 * they are rewritten in-place with a new validTo.
 *
 * MemKraft parity: file is rewritten entirely, with each open-ended fact
 * matching `key` getting `validTo = invalidAt` (default: today) and a fresh
 * `recordedAt` (default: now).
 */
export function factInvalidate(
  projectMemory: ProjectMemoryCore,
  entity: string,
  key: string,
  opts?: { invalidAt?: string; recordedAt?: string },
): number {
  const path = factFile(projectMemory, entity);
  if (!existsSync(path)) return 0;

  const invalidAt = normaliseDate(opts?.invalidAt) ?? todayIso();
  const rec = normaliseDate(opts?.recordedAt) ?? nowIso();

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }

  let modified = 0;
  const newLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed && parsed.key === key && parsed.validTo === undefined) {
      const closed = formatLine(parsed.key, parsed.value, parsed.validFrom, invalidAt, rec);
      newLines.push(closed);
      modified += 1;
    } else {
      newLines.push(line);
    }
  }

  if (modified > 0) {
    try {
      // Preserve trailing newline behaviour: text.split keeps a trailing empty
      // entry when the file ended with `\n`. Re-join + ensure final newline.
      let out = newLines.join("\n");
      if (!out.endsWith("\n")) out += "\n";
      writeFileSync(path, out, "utf-8");
    } catch {
      return 0;
    }
  }
  return modified;
}

/** All facts for entity (alias of factHistory with no key filter). */
export function factList(projectMemory: ProjectMemoryCore, entity: string): FactRecord[] {
  return factHistory(projectMemory, entity);
}

/** Distinct keys recorded for entity, sorted ascending. */
export function factKeys(projectMemory: ProjectMemoryCore, entity: string): string[] {
  const set = new Set<string>();
  for (const f of readFactsRaw(projectMemory, entity)) set.add(f.key);
  return [...set].sort();
}
