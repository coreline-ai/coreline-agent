/**
 * MemKraft working set selector — chooses hot memories for system prompt injection.
 */

import { WORKING_SET_DEFAULT_LIMIT } from "./constants.js";
import { tierList, tierTouch } from "./tiering.js";
import type { MemoryEntry, ProjectMemoryCore } from "./types.js";

export interface SelectWorkingSetOptions {
  projectMemory: ProjectMemoryCore;
  /** Max entries returned. core is always included (may exceed limit if core > limit). */
  limit?: number;
  /** If true, bump lastAccessed/accessCount on each returned entry. Default false. */
  touch?: boolean;
}

export interface WorkingSetStats {
  entries: MemoryEntry[];
  coreCount: number;
  recallCount: number;
  archivedCount: number;
  omittedCount: number;
}

/** Resolve the effective working set limit from env var or default. */
export function getWorkingSetLimit(): number {
  const raw = process.env.CORELINE_WORKING_SET_LIMIT;
  if (raw === undefined || raw === null) {
    return WORKING_SET_DEFAULT_LIMIT;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return WORKING_SET_DEFAULT_LIMIT;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return WORKING_SET_DEFAULT_LIMIT;
  }
  return parsed;
}

function computeSelection(options: SelectWorkingSetOptions): WorkingSetStats {
  const { projectMemory } = options;
  const limit = options.limit ?? getWorkingSetLimit();

  const coreEntries = tierList(projectMemory, { tier: "core" });
  const recallEntries = tierList(projectMemory, { tier: "recall" });
  const archivalEntries = tierList(projectMemory, { tier: "archival" });

  let entries: MemoryEntry[];
  let recallTaken: number;

  if (coreEntries.length >= limit) {
    // MemKraft TC-2.3 — never truncate core; unbounded by design.
    entries = [...coreEntries];
    recallTaken = 0;
  } else {
    const remaining = Math.max(0, limit - coreEntries.length);
    const recallSlice = recallEntries.slice(0, remaining);
    entries = [...coreEntries, ...recallSlice];
    recallTaken = recallSlice.length;
  }

  if (options.touch === true) {
    for (const entry of entries) {
      tierTouch(projectMemory, entry.name);
    }
  }

  return {
    entries,
    coreCount: coreEntries.length,
    recallCount: recallTaken,
    archivedCount: archivalEntries.length,
    omittedCount: Math.max(0, recallEntries.length - recallTaken),
  };
}

/** Return just the entries (common case). */
export function selectWorkingSet(options: SelectWorkingSetOptions): MemoryEntry[] {
  return computeSelection(options).entries;
}

/** Return entries + counts (for debug annotation). */
export function selectWorkingSetWithStats(
  options: SelectWorkingSetOptions,
): WorkingSetStats {
  return computeSelection(options);
}
