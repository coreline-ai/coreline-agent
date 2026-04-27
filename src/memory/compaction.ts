/** Memory compaction — ports MemKraft lifecycle.py:170-244 (90/30-day archival rules). */

import { statSync } from "node:fs";

import { tierSet } from "./tiering.js";
import type { MemoryEntry, ProjectMemoryCore } from "./types.js";

export interface CompactOptions {
  projectMemory: ProjectMemoryCore;
  /** Total-bytes soft limit; rule 3 archives oldest recall when exceeded. Default 15000. */
  maxChars?: number;
  /** If true, returns counts but does not persist tier changes. */
  dryRun?: boolean;
}

export interface CompactResult {
  moved: number;
  remainingEntities: number;
  freedChars: number;
  dryRun: boolean;
  /** Entries archived, for display. */
  movedNames: string[];
}

const DEFAULT_MAX_CHARS = 15_000;
const MS_PER_DAY = 86_400_000;

/**
 * Load every entry fresh from disk (cannot reuse tierList() because it sorts;
 * we need per-entry ordering flexibility, plus this is invoked rarely).
 */
function loadAllEntries(projectMemory: ProjectMemoryCore): MemoryEntry[] {
  const index = projectMemory.listEntries();
  const out: MemoryEntry[] = [];
  for (const item of index) {
    const entry = projectMemory.readEntry(item.name);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Compute age in days from lastAccessed (YYYY-MM-DD) or file mtime fallback.
 * Returns `null` when neither signal is available — caller must skip such entries.
 */
function daysOldFor(entry: MemoryEntry, now: number): number | null {
  if (entry.lastAccessed) {
    const parsed = Date.parse(entry.lastAccessed);
    if (Number.isFinite(parsed)) {
      const diff = (now - parsed) / MS_PER_DAY;
      return diff >= 0 ? diff : 0;
    }
  }
  try {
    const stat = statSync(entry.filePath);
    const diff = (now - stat.mtime.getTime()) / MS_PER_DAY;
    return diff >= 0 ? diff : 0;
  } catch {
    return null;
  }
}

function entryChars(entry: MemoryEntry): number {
  return (entry.body?.length ?? 0) + (entry.description?.length ?? 0);
}

/**
 * Apply MemKraft compaction rules. See module header for rule list.
 * Rules evaluated on a snapshot; rule 3 iterates oldest-first until under limit.
 */
export function compact(options: CompactOptions): CompactResult {
  const { projectMemory } = options;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const dryRun = options.dryRun ?? false;

  const entries = loadAllEntries(projectMemory);
  const now = Date.now();

  // Precompute daysOld once per entry — skip any with no temporal signal.
  const ages = new Map<string, number>();
  for (const entry of entries) {
    const days = daysOldFor(entry, now);
    if (days !== null) {
      ages.set(entry.name, days);
    }
  }

  const archived = new Set<string>();
  const movedNames: string[] = [];
  let freedChars = 0;

  const archive = (entry: MemoryEntry): void => {
    if (archived.has(entry.name)) return;
    archived.add(entry.name);
    movedNames.push(entry.name);
    freedChars += entryChars(entry);
    if (!dryRun) {
      tierSet(projectMemory, entry.name, "archival");
    }
  };

  // Rule 1: daysOld > 90 AND tier !== core → archival.
  // Rule 2: importance === low AND daysOld > 30 → archival (also tier !== core).
  for (const entry of entries) {
    const tier = entry.tier ?? "recall";
    // Skip core (protected) and archival (already compacted — avoids double-counting
    // on repeated compact() calls).
    if (tier === "core" || tier === "archival") continue;
    const days = ages.get(entry.name);
    if (days === undefined) continue;

    if (days > 90) {
      archive(entry);
      continue;
    }
    if (entry.importance === "low" && days > 30) {
      archive(entry);
    }
  }

  // Rule 3: total_chars > maxChars AND tier === recall AND daysOld > 30 →
  // archive oldest-first until under limit (or no more candidates).
  const totalChars = entries
    .filter((e) => !archived.has(e.name))
    .reduce((sum, e) => sum + entryChars(e), 0);

  if (totalChars > maxChars) {
    const candidates = entries
      .filter((e) => !archived.has(e.name))
      .filter((e) => (e.tier ?? "recall") === "recall")
      .filter((e) => {
        const d = ages.get(e.name);
        return d !== undefined && d > 30;
      })
      .sort((a, b) => (ages.get(b.name) ?? 0) - (ages.get(a.name) ?? 0));

    let running = totalChars;
    for (const entry of candidates) {
      if (running <= maxChars) break;
      const cost = entryChars(entry);
      archive(entry);
      running -= cost;
    }
  }

  const remainingEntities = entries.length - archived.size;

  return {
    moved: archived.size,
    remainingEntities,
    freedChars,
    dryRun,
    movedNames,
  };
}
