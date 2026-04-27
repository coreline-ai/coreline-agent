/**
 * tierList LRU cache — Wave 10 P3 O2.
 *
 * Caches the unfiltered tierList result per projectId to avoid re-reading
 * all memory files on every buildSystemPrompt invocation. Invalidated by
 * tierSet/tierPromote/tierDemote/tierTouch, writeEntry, deleteEntry.
 */

import type { MemoryEntry, ProjectMemoryCore } from "./types.js";

const DEFAULT_CAP = 100;

interface CachedTierList {
  entries: ReadonlyArray<MemoryEntry>;
  cachedAt: number;
}

const cache = new Map<string, CachedTierList>();
let hits = 0;
let misses = 0;

function isEnabled(): boolean {
  return process.env.MEMORY_TIER_CACHE_ENABLE !== "false";
}

/**
 * Get cached entries for a project, marking the entry as recently used.
 * Returns null on miss (and increments miss counter).
 */
export function getCached(projectId: string): ReadonlyArray<MemoryEntry> | null {
  const found = cache.get(projectId);
  if (!found) {
    misses += 1;
    return null;
  }
  // LRU refresh — re-insert to move to end.
  cache.delete(projectId);
  cache.set(projectId, found);
  hits += 1;
  return found.entries;
}

/**
 * Store entries for a project. Evicts oldest if over cap.
 */
export function setCached(
  projectId: string,
  entries: ReadonlyArray<MemoryEntry>,
): void {
  // Defensive: snapshot a frozen shallow copy so callers can't mutate cache state.
  const snapshot = Object.freeze([...entries]) as ReadonlyArray<MemoryEntry>;
  if (cache.has(projectId)) {
    cache.delete(projectId);
  }
  cache.set(projectId, { entries: snapshot, cachedAt: Date.now() });

  // Evict oldest entries beyond cap.
  while (cache.size > DEFAULT_CAP) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/**
 * Invalidate cached entries for a single project.
 */
export function invalidate(projectId: string): void {
  cache.delete(projectId);
}

/**
 * Invalidate all cached entries (useful for tests).
 */
export function invalidateAll(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * Cache stats for observability/tests.
 */
export function cacheStats(): { size: number; hits: number; misses: number } {
  return { size: cache.size, hits, misses };
}

/**
 * Check whether the cache is enabled via env var.
 */
export function isCacheEnabled(): boolean {
  return isEnabled();
}

/**
 * Convenience: get-or-compute helper. Honors enable flag.
 */
export function getOrCompute(
  projectMemory: ProjectMemoryCore,
  compute: () => ReadonlyArray<MemoryEntry>,
): ReadonlyArray<MemoryEntry> {
  if (!isEnabled()) {
    return compute();
  }
  const cached = getCached(projectMemory.projectId);
  if (cached) return cached;
  const computed = compute();
  setCached(projectMemory.projectId, computed);
  return computed;
}
