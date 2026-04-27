/**
 * Decay + Tombstone types — MemKraft Wave 7 Phase 2 (decay.py port).
 *
 * Reversible decay: numeric weight (0..1) on each memory entry, with
 * full restore + soft-delete (tombstone) semantics.
 */

export interface DecayState {
  /** Memory entry name (matches `MemoryEntry.name`). */
  name: string;
  /** Absolute path to the markdown file (live or tombstoned). */
  filePath: string;
  /** Current decay weight in [0, 1]. */
  decayWeight: number;
  /** Number of times decay has been applied. */
  decayCount: number;
  /** ISO date (YYYY-MM-DD) of last access/decay touch. */
  lastAccessed?: string;
  /** True iff entry is soft-deleted (file moved to tombstones dir). */
  tombstoned: boolean;
  /** ISO timestamp when tombstoned (YYYY-MM-DDTHH:MM). */
  tombstonedAt?: string;
}

export interface DecayQuery {
  /** Match entries whose `lastAccessed` is older than N days. */
  olderThanDays?: number;
  /** Match entries whose `decayCount` is strictly less than N. */
  accessCountLt?: number;
  /** Match entries whose current `decayWeight` is strictly greater than N. */
  weightGt?: number;
}

export interface DecayResult {
  /** Number of entries successfully decayed. */
  applied: number;
  /** Post-decay states for each affected entry. */
  states: DecayState[];
  /** Per-entry errors (best-effort batch — collected, not thrown). */
  errors?: { name: string; error: string }[];
}
