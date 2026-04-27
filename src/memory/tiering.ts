/**
 * MemKraft 3-tier memory operations — tierSet/Get/Promote/Demote/Touch/List (tiers.py port).
 */

import {
  AUTO_PROMOTE_THRESHOLD as _AUTO_PROMOTE_THRESHOLD,
  DEFAULT_TIER,
  DEFAULT_TIER_FOR_TYPE,
  TIER_ORDER,
} from "./constants.js";
import {
  getCached,
  invalidate as invalidateTierCache,
  isCacheEnabled,
  setCached,
} from "./tier-list-cache.js";
import type { MemoryEntry, MemoryTier, MemoryType, ProjectMemoryCore } from "./types.js";

// Mark unused import as intentionally kept (re-exported for later phases).
void _AUTO_PROMOTE_THRESHOLD;

const VALID_TIERS: readonly MemoryTier[] = ["core", "recall", "archival"];

function isMemoryTier(value: unknown): value is MemoryTier {
  return typeof value === "string" && (VALID_TIERS as readonly string[]).includes(value);
}

/**
 * Today as YYYY-MM-DD — shared helper for tier/working-set/compaction modules.
 */
export function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Default tier for a given memory type — falls back to DEFAULT_TIER for unknown types.
 */
export function defaultTierForType(type: MemoryType): MemoryTier {
  const mapped = DEFAULT_TIER_FOR_TYPE[type];
  return mapped ?? DEFAULT_TIER;
}

function requireEntry(projectMemory: ProjectMemoryCore, name: string): MemoryEntry {
  const entry = projectMemory.readEntry(name);
  if (!entry) {
    throw new Error(`memory entry not found: ${name}`);
  }
  return entry;
}

/**
 * Set tier on an entity. Throws if entity doesn't exist or tier is invalid.
 */
export function tierSet(
  projectMemory: ProjectMemoryCore,
  name: string,
  tier: MemoryTier,
): void {
  if (!isMemoryTier(tier)) {
    throw new Error(
      `tier must be one of ["core","recall","archival"], got ${JSON.stringify(tier)}`,
    );
  }
  const entry = requireEntry(projectMemory, name);
  projectMemory.writeEntry({ ...entry, tier });
  try {
    invalidateTierCache(projectMemory.projectId);
  } catch {
    /* noop */
  }
}

/**
 * Get current tier. Returns DEFAULT_TIER if entity missing or tier unset. Never throws.
 */
export function tierOf(projectMemory: ProjectMemoryCore, name: string): MemoryTier {
  try {
    const entry = projectMemory.readEntry(name);
    if (!entry) {
      return DEFAULT_TIER;
    }
    return entry.tier ?? DEFAULT_TIER;
  } catch {
    return DEFAULT_TIER;
  }
}

/**
 * Promote one step in [archival, recall, core] order. No-op at top (core).
 */
export function tierPromote(projectMemory: ProjectMemoryCore, name: string): MemoryTier {
  const entry = requireEntry(projectMemory, name);
  const current: MemoryTier = entry.tier ?? DEFAULT_TIER;
  const next: MemoryTier =
    current === "archival" ? "recall" : current === "recall" ? "core" : "core";
  if (next !== current) {
    projectMemory.writeEntry({ ...entry, tier: next });
    try {
      invalidateTierCache(projectMemory.projectId);
    } catch {
      /* noop */
    }
  }
  return next;
}

/**
 * Demote one step. No-op at bottom (archival).
 */
export function tierDemote(projectMemory: ProjectMemoryCore, name: string): MemoryTier {
  const entry = requireEntry(projectMemory, name);
  const current: MemoryTier = entry.tier ?? DEFAULT_TIER;
  const next: MemoryTier =
    current === "core" ? "recall" : current === "recall" ? "archival" : "archival";
  if (next !== current) {
    projectMemory.writeEntry({ ...entry, tier: next });
    try {
      invalidateTierCache(projectMemory.projectId);
    } catch {
      /* noop */
    }
  }
  return next;
}

/**
 * Bump lastAccessed (today YYYY-MM-DD) and accessCount (+1). Does NOT change tier.
 */
export function tierTouch(projectMemory: ProjectMemoryCore, name: string): MemoryEntry {
  const entry = requireEntry(projectMemory, name);
  const updated: MemoryEntry = {
    ...entry,
    lastAccessed: todayIso(),
    accessCount: (entry.accessCount ?? 0) + 1,
  };
  projectMemory.writeEntry(updated);
  try {
    invalidateTierCache(projectMemory.projectId);
  } catch {
    /* noop */
  }
  return updated;
}

/**
 * List all entries sorted by (tier desc via TIER_ORDER, then lastAccessed desc).
 * Entries missing lastAccessed sort last within their tier. Optional tier filter.
 */
export function tierList(
  projectMemory: ProjectMemoryCore,
  options: { tier?: MemoryTier } = {},
): MemoryEntry[] {
  // O2: Try cache first (only when MEMORY_TIER_CACHE_ENABLE !== "false").
  const cacheEnabled = process.env.MEMORY_TIER_CACHE_ENABLE !== "false";
  let entries: MemoryEntry[];
  const cached = cacheEnabled ? getCached(projectMemory.projectId) : null;
  if (cached) {
    entries = [...cached]; // defensive copy
  } else {
    const index = projectMemory.listEntries();
    entries = [];
    for (const item of index) {
      const entry = projectMemory.readEntry(item.name);
      if (entry) {
        entries.push(entry);
      }
    }
    if (cacheEnabled) {
      setCached(projectMemory.projectId, entries);
    }
  }

  const filtered =
    options.tier !== undefined
      ? entries.filter((e) => (e.tier ?? DEFAULT_TIER) === options.tier)
      : entries;

  filtered.sort((a, b) => {
    const aTier = a.tier ?? DEFAULT_TIER;
    const bTier = b.tier ?? DEFAULT_TIER;
    const tierDiff = TIER_ORDER[bTier] - TIER_ORDER[aTier];
    if (tierDiff !== 0) {
      return tierDiff;
    }
    const aLast = a.lastAccessed;
    const bLast = b.lastAccessed;
    if (aLast && bLast) {
      if (aLast === bLast) return 0;
      return aLast < bLast ? 1 : -1;
    }
    if (aLast && !bLast) return -1;
    if (!aLast && bLast) return 1;
    return 0;
  });

  return filtered;
}
