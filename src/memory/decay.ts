/**
 * Reversible decay + tombstone — MemKraft Wave 7 Phase 2 (decay.py port).
 *
 * Decay reduces a memory's `decayWeight` (0..1) without deleting the file;
 * tombstone moves the file under `<projectDir>/.memory/tombstones/` and can
 * always be reversed via `decayRestore`. All operations preserve frontmatter
 * extras and round weights to 6 decimals (parity with MemKraft).
 *
 * Runtime fallback (D17): a missing `decayWeight` is treated as 1.0; on write
 * we omit the field whenever the value collapses back to a default to keep
 * legacy frontmatter byte-identical.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ensureTombstonesDir, getTombstonesDir } from "../config/paths.js";
import { DECAY_DEFAULT_RATE, DECAY_DEFAULT_WEIGHT } from "./constants.js";
import { extractExtendedFields, parseMemoryFile, validateMemoryType } from "./memory-parser.js";
import type { DecayQuery, DecayResult, DecayState } from "./decay-types.js";
import type { MemoryEntry, ProjectMemoryCore } from "./types.js";

const MS_PER_DAY = 86_400_000;

function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowIsoMinute(): string {
  // Match MemKraft format: YYYY-MM-DDTHH:MM (decay.py:326).
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function effectiveWeight(entry: MemoryEntry): number {
  return entry.decayWeight ?? DECAY_DEFAULT_WEIGHT;
}

function effectiveCount(entry: MemoryEntry): number {
  return entry.decayCount ?? 0;
}

function buildDecayState(entry: MemoryEntry): DecayState {
  return {
    name: entry.name,
    filePath: entry.filePath,
    decayWeight: effectiveWeight(entry),
    decayCount: effectiveCount(entry),
    lastAccessed: entry.lastAccessed,
    tombstoned: entry.tombstoned ?? false,
    tombstonedAt: entry.tombstonedAt,
  };
}

/**
 * Apply rounded multiplicative decay to a single entry.
 *
 * @throws if the entry does not exist or rate is outside (0, 1) exclusive.
 */
export function decayApply(
  projectMemory: ProjectMemoryCore,
  name: string,
  opts: { decayRate?: number } = {},
): DecayState {
  const rate = opts.decayRate ?? DECAY_DEFAULT_RATE;
  if (!(rate > 0 && rate < 1)) {
    throw new Error(`decayRate must be in (0, 1) exclusive — got ${rate}`);
  }

  const entry = projectMemory.readEntry(name);
  if (!entry) {
    throw new Error(`memory entry not found: ${name}`);
  }

  const newWeight = round6(effectiveWeight(entry) * (1 - rate));
  const newCount = effectiveCount(entry) + 1;
  const lastAccessed = todayDate();

  const updated: MemoryEntry = {
    ...entry,
    decayWeight: newWeight,
    decayCount: newCount,
    lastAccessed,
  };

  projectMemory.writeEntry(updated);

  // Re-read so that filePath / serializer round-trip is observable.
  const persisted = projectMemory.readEntry(name) ?? updated;
  return buildDecayState(persisted);
}

/**
 * List entries whose effective decay weight is strictly below `belowThreshold`
 * (default 1.0). Tombstoned entries are excluded unless `includeTombstoned` is true.
 */
export function decayList(
  projectMemory: ProjectMemoryCore,
  opts: { belowThreshold?: number; includeTombstoned?: boolean } = {},
): DecayState[] {
  const threshold = opts.belowThreshold ?? 1.0;
  const includeTombstoned = opts.includeTombstoned ?? false;

  const out: DecayState[] = [];

  // Live (non-tombstoned) entries from project memory.
  for (const indexed of projectMemory.listEntries()) {
    const entry = projectMemory.readEntry(indexed.name);
    if (!entry) continue;
    const tombstoned = entry.tombstoned === true;
    if (tombstoned && !includeTombstoned) continue;
    const w = effectiveWeight(entry);
    if (w < threshold) {
      out.push(buildDecayState(entry));
    }
  }

  // Tombstoned files in the tombstones dir (only if requested).
  if (includeTombstoned) {
    const tombDir = getTombstonesDir(projectMemory.projectId, configRootOf(projectMemory));
    if (existsSync(tombDir)) {
      for (const file of readdirSync(tombDir)) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(tombDir, file);
        const tombState = readTombstoneState(filePath);
        if (!tombState) continue;
        if (tombState.decayWeight < threshold) {
          out.push(tombState);
        }
      }
    }
  }

  out.sort((a, b) => a.decayWeight - b.decayWeight);
  return out;
}

/**
 * Fully restore a decayed (or tombstoned) memory:
 * weight=1.0, count=0, tombstoned=false, lastAccessed=today.
 * If the file currently lives in the tombstones dir, it is moved back to the
 * project memory dir before fields are reset.
 *
 * @throws if neither active nor tombstoned file is found.
 */
export function decayRestore(projectMemory: ProjectMemoryCore, name: string): DecayState {
  let entry = projectMemory.readEntry(name);

  if (!entry) {
    // Try recovering from the tombstones directory.
    const recovered = recoverFromTombstones(projectMemory, name);
    if (!recovered) {
      throw new Error(`memory entry not found (live or tombstoned): ${name}`);
    }
    entry = projectMemory.readEntry(recovered.name);
    if (!entry) {
      throw new Error(`failed to read restored entry: ${name}`);
    }
  }

  // Reset to defaults — pass undefined so the serializer drops the keys
  // (D17 byte-identical legacy format requirement).
  const restored: MemoryEntry = {
    ...entry,
    decayWeight: undefined,
    decayCount: undefined,
    tombstoned: undefined,
    tombstonedAt: undefined,
    lastAccessed: todayDate(),
  };

  projectMemory.writeEntry(restored);

  const persisted = projectMemory.readEntry(entry.name) ?? restored;
  return buildDecayState(persisted);
}

/**
 * Batch-decay entries matching the AND of all provided criteria.
 * Tombstoned entries are skipped. Errors from individual `decayApply` calls
 * are collected (best-effort) instead of aborting the run.
 */
export function decayRun(
  projectMemory: ProjectMemoryCore,
  criteria: DecayQuery,
  decayRate: number = DECAY_DEFAULT_RATE,
): DecayResult {
  const states: DecayState[] = [];
  const errors: { name: string; error: string }[] = [];
  const now = Date.now();

  for (const indexed of projectMemory.listEntries()) {
    const entry = projectMemory.readEntry(indexed.name);
    if (!entry) continue;
    if (entry.tombstoned === true) continue;

    if (criteria.weightGt !== undefined && effectiveWeight(entry) <= criteria.weightGt) {
      continue;
    }
    if (criteria.accessCountLt !== undefined && effectiveCount(entry) >= criteria.accessCountLt) {
      continue;
    }
    if (criteria.olderThanDays !== undefined) {
      if (!entry.lastAccessed) continue;
      const parsed = Date.parse(entry.lastAccessed);
      if (!Number.isFinite(parsed)) continue;
      const ageDays = (now - parsed) / MS_PER_DAY;
      if (ageDays <= criteria.olderThanDays) continue;
    }

    try {
      const state = decayApply(projectMemory, entry.name, { decayRate });
      states.push(state);
    } catch (err) {
      errors.push({ name: entry.name, error: (err as Error).message });
    }
  }

  return errors.length > 0
    ? { applied: states.length, states, errors }
    : { applied: states.length, states };
}

/**
 * Soft-delete: mark tombstoned + decayWeight=0 in frontmatter, then move the
 * markdown file under `<projectDir>/.memory/tombstones/`. Collisions are
 * suffixed `{stem}.{n}.md` (n=1, 2, ...).
 *
 * @throws if the entry does not exist.
 */
export function decayTombstone(projectMemory: ProjectMemoryCore, name: string): DecayState {
  const entry = projectMemory.readEntry(name);
  if (!entry) {
    throw new Error(`memory entry not found: ${name}`);
  }

  const tombstonedAt = nowIsoMinute();
  const updated: MemoryEntry = {
    ...entry,
    tombstoned: true,
    tombstonedAt,
    decayWeight: 0,
  };

  // Write frontmatter updates first so the file has the tombstone marker baked in.
  projectMemory.writeEntry(updated);

  const sourcePath = entry.filePath;
  const tombDir = ensureTombstonesDir(projectMemory.projectId, configRootOf(projectMemory));
  const sourceName = basename(sourcePath);
  const stem = sourceName.endsWith(".md") ? sourceName.slice(0, -3) : sourceName;
  let dest = join(tombDir, `${stem}.md`);
  let i = 1;
  while (existsSync(dest)) {
    dest = join(tombDir, `${stem}.${i}.md`);
    i += 1;
  }

  if (existsSync(sourcePath)) {
    renameSync(sourcePath, dest);
  }

  // Drop the entry from the index — the file no longer lives in memoryDir.
  // `deleteEntry` is index-aware: if the file is already gone it just rewrites
  // the index (returning true since the index still had the row).
  projectMemory.deleteEntry(name);

  return {
    name: entry.name,
    filePath: dest,
    decayWeight: 0,
    decayCount: effectiveCount(updated),
    lastAccessed: updated.lastAccessed,
    tombstoned: true,
    tombstonedAt,
  };
}

/**
 * Returns true iff the entry is marked tombstoned (live frontmatter) or its
 * file is found inside the tombstones directory.
 */
export function decayIsTombstoned(projectMemory: ProjectMemoryCore, name: string): boolean {
  const entry = projectMemory.readEntry(name);
  if (entry?.tombstoned === true) return true;

  const tombDir = getTombstonesDir(projectMemory.projectId, configRootOf(projectMemory));
  if (!existsSync(tombDir)) return false;
  const stem = name;
  for (const file of readdirSync(tombDir)) {
    if (!file.endsWith(".md")) continue;
    const fileStem = file.slice(0, -3);
    // exact match, or "{stem}.{n}" collision suffix
    if (fileStem === stem || fileStem.startsWith(`${stem}.`)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Generate sanitized variants of a memory name for legacy tombstone lookup
 * (R4). Older entries may have been written with spaces, special characters,
 * or non-ASCII (Korean) names that no longer round-trip via the current
 * `entryFileName` slug. We probe a small fixed set of canonical forms before
 * giving up.
 */
function generateNameVariants(name: string): string[] {
  const variants = new Set<string>();
  variants.add(name); // exact
  variants.add(name.toLowerCase()); // lowercase
  variants.add(name.replace(/\s+/g, "_")); // spaces → underscore
  variants.add(name.replace(/\s+/g, "-")); // spaces → dash
  variants.add(name.replace(/[^\w가-힣-]/g, "_")); // sanitize special (preserve Korean)
  variants.add(name.replace(/[^\w가-힣-]/g, "-"));
  return Array.from(variants);
}

/**
 * Locate a tombstoned markdown file for `name`, trying sanitized variants so
 * legacy entries (spaces, slashes, Korean) still resolve. Returns the absolute
 * path to the matched file, or null if nothing matched.
 */
function findTombstoneFile(tombstoneDir: string, name: string): string | null {
  if (!existsSync(tombstoneDir)) return null;
  const files = readdirSync(tombstoneDir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return null;

  const candidates = generateNameVariants(name);
  for (const variant of candidates) {
    for (const file of files) {
      const fileStem = file.slice(0, -3);
      // exact stem match, or "{variant}.{n}" collision suffix
      if (fileStem === variant || fileStem.startsWith(`${variant}.`)) {
        return join(tombstoneDir, file);
      }
    }
  }
  return null;
}

/**
 * Recover a previously tombstoned file. Moves the first matching file under
 * the tombstones dir back into the project memory dir. Returns the file path
 * after the move, or null if nothing matched. Tries sanitized name variants
 * (R4) so that legacy entries with spaces / non-ASCII / special chars resolve.
 */
function recoverFromTombstones(
  projectMemory: ProjectMemoryCore,
  name: string,
): { name: string; filePath: string } | null {
  const tombDir = getTombstonesDir(projectMemory.projectId, configRootOf(projectMemory));
  const source = findTombstoneFile(tombDir, name);
  if (!source) return null;

  // Resolve the canonical entry name from frontmatter when available, falling
  // back to the file stem (with collision suffix `.N` stripped). The caller's
  // `name` may carry path separators or whitespace that aren't safe to use as
  // a destination filename, so we re-derive both the entry name and the on-disk
  // stem from the tombstoned file.
  const sourceBase = basename(source);
  const rawStem = sourceBase.endsWith(".md") ? sourceBase.slice(0, -3) : sourceBase;
  // Strip trailing `.N` collision suffix (e.g. "duplicate.1" → "duplicate").
  const fileStem = rawStem.replace(/\.\d+$/, "");
  let resolvedName = fileStem;
  try {
    const text = readFileSync(source, "utf-8");
    const parsed = parseMemoryFile(text);
    const fmName = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
    if (fmName) resolvedName = fmName;
  } catch {
    // Keep stem fallback.
  }

  // Memory dir is created lazily by ProjectMemory; ensure it exists before
  // moving the file back.
  if (!existsSync(projectMemory.memoryDir)) {
    mkdirSync(projectMemory.memoryDir, { recursive: true });
  }

  // Compute the on-disk stem the same way ProjectMemory does
  // (`[\\/]` → `_`) so subsequent `readEntry(resolvedName)` can find it.
  const destStem = resolvedName.replace(/[\\/]/g, "_");
  const dest = join(projectMemory.memoryDir, `${destStem}.md`);
  renameSync(source, dest);
  return { name: resolvedName, filePath: dest };
}

/**
 * Read a tombstoned markdown file (lives outside the project memory dir, so
 * `readEntry` cannot reach it). Returns a minimal DecayState — name is taken
 * from frontmatter when valid, otherwise from the file stem.
 */
function readTombstoneState(filePath: string): DecayState | null {
  try {
    const text = readFileSync(filePath, "utf-8");
    const parsed = parseMemoryFile(text);
    const extended = extractExtendedFields(parsed.frontmatter);
    const fmName = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
    const name = fmName || basename(filePath).replace(/\.md$/i, "");
    const fmType =
      typeof parsed.frontmatter.type === "string" && validateMemoryType(parsed.frontmatter.type)
        ? parsed.frontmatter.type
        : null;
    if (!name || !fmType) {
      // Tombstoned entries are still memory entries — but we don't gate on type
      // here (some tests/inputs may differ). Use what we can.
    }
    return {
      name,
      filePath,
      decayWeight: extended.decayWeight ?? DECAY_DEFAULT_WEIGHT,
      decayCount: extended.decayCount ?? 0,
      lastAccessed: extended.lastAccessed,
      tombstoned: extended.tombstoned ?? true,
      tombstonedAt: extended.tombstonedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Recover the rootDir from a ProjectMemoryCore. ProjectMemory does not expose
 * its rootDir publicly, so we derive it from `projectDir` (which is always
 * `<rootDir>/projects/<projectId>`).
 */
function configRootOf(projectMemory: ProjectMemoryCore): string {
  // projectDir = <rootDir>/projects/<projectId>
  return dirname(dirname(projectMemory.projectDir));
}
