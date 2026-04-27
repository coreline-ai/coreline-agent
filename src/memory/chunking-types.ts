/**
 * Chunking types — MemKraft chunking.py port (Wave 7 Phase 4).
 */

import type { MemoryEntry, MemoryType } from "./types.js";

export interface ChunkingOptions {
  /** Words per chunk. Defaults to CHUNK_DEFAULT_SIZE (500). */
  chunkSize?: number;
  /** Overlap in words between consecutive chunks. Defaults to CHUNK_DEFAULT_OVERLAP (50). */
  chunkOverlap?: number;
  /** Memory type to assign to parent + chunk entries. Defaults to "reference". */
  entityType?: MemoryType;
  /** Optional source/provenance tag stored as the parent entry description. */
  source?: string;
}

export interface ChunkingFailure {
  chunkIdx: number;
  error: string;
}

export interface ChunkingResult {
  docId: string;
  chunksCreated: number;
  parentTracked: boolean;
  failures: ChunkingFailure[];
}

export interface PreciseSearchOptions {
  /** Maximum number of hits returned. Default 5. */
  topK?: number;
  /** Minimum token-overlap score for fuzzy fallback. Default 0.1. */
  scoreThreshold?: number;
}

export interface PreciseSearchResult {
  results: MemoryEntry[];
  /** True when fuzzy fallback was triggered because precise pass found nothing. */
  fallbackUsed: boolean;
}
