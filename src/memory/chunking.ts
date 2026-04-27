/**
 * Document chunking — MemKraft chunking.py port (Wave 7 Phase 4).
 *
 * Provides:
 * - chunkText(): word-level overlapping split.
 * - trackDocument(): persist parent + chunk entries via ProjectMemoryCore.
 * - searchPrecise(): exact-substring first, fuzzy token-overlap fallback.
 */

import {
  CHUNK_DEFAULT_OVERLAP,
  CHUNK_DEFAULT_SIZE,
  MAX_CHUNKS_PER_DOC,
} from "./constants.js";
import type {
  ChunkingFailure,
  ChunkingOptions,
  ChunkingResult,
  PreciseSearchOptions,
  PreciseSearchResult,
} from "./chunking-types.js";
import type { MemoryEntry, ProjectMemoryCore } from "./types.js";

// ---------------------------------------------------------------------------
// chunkText — word-level split with overlap (MemKraft chunking.py:34-56 port)
// ---------------------------------------------------------------------------

/**
 * Split `text` into ~size-word overlapping chunks.
 *
 * Algorithm:
 * - Split on `\s+`, preserve word order.
 * - step = size - overlap. If overlap >= size → throw (parity with MemKraft).
 * - Iterate i=0..words.length, push words.slice(i, i+size).join(" ") each step.
 * - Empty/whitespace-only text → [].
 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  if (size <= 0) {
    throw new Error(`chunkText: size must be > 0 (got ${size})`);
  }
  if (overlap < 0) {
    throw new Error(`chunkText: overlap must be >= 0 (got ${overlap})`);
  }
  if (overlap >= size) {
    throw new Error(`chunkText: overlap must be < size (overlap=${overlap}, size=${size})`);
  }

  if (!text || text.trim().length === 0) {
    return [];
  }

  const words = text.trim().split(/\s+/);
  if (words.length === 0) return [];

  const step = size - overlap; // > 0 guaranteed by checks above
  const chunks: string[] = [];

  for (let i = 0; i < words.length; i += step) {
    const piece = words.slice(i, i + size);
    if (piece.length === 0) break;
    chunks.push(piece.join(" "));
    // If this chunk reached the end, stop — overlap on the tail would duplicate.
    if (i + size >= words.length) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// trackDocument — write parent + chunk entries (best-effort per chunk)
// ---------------------------------------------------------------------------

/**
 * Split `content` into chunks and persist parent + chunks into projectMemory.
 *
 * Parent: name=docId, body="(chunks: N)"
 * Chunks: name=`${docId}__c${i}`, body=chunk text
 *
 * Throws if `chunks.length > MAX_CHUNKS_PER_DOC`. Per-chunk write failures are
 * captured into `result.failures` and do NOT abort the loop.
 */
export function trackDocument(
  projectMemory: ProjectMemoryCore,
  docId: string,
  content: string,
  opts: ChunkingOptions = {},
): ChunkingResult {
  const chunkSize = opts.chunkSize ?? CHUNK_DEFAULT_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? CHUNK_DEFAULT_OVERLAP;
  const entityType = opts.entityType ?? "reference";
  const source = opts.source ?? "document";

  if (chunkOverlap >= chunkSize) {
    throw new Error(
      `trackDocument: chunkOverlap must be < chunkSize (overlap=${chunkOverlap}, size=${chunkSize})`,
    );
  }

  const chunks = chunkText(content, chunkSize, chunkOverlap);

  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    throw new Error(
      `Document too large: ${chunks.length} chunks exceeds max ${MAX_CHUNKS_PER_DOC}`,
    );
  }

  const failures: ChunkingFailure[] = [];

  // 1. Write parent entry.
  let parentTracked = false;
  try {
    projectMemory.writeEntry({
      name: docId,
      description: source,
      type: entityType,
      body: `(chunks: ${chunks.length})`,
      filePath: "",
      tier: "recall",
    });
    parentTracked = true;
  } catch (err) {
    failures.push({
      chunkIdx: -1,
      error: `parent write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2. Write each chunk.
  let chunksCreated = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    try {
      projectMemory.writeEntry({
        name: `${docId}__c${i}`,
        description: `chunk ${i + 1}/${chunks.length} of ${docId}`,
        type: entityType,
        body: chunk,
        filePath: "",
        tier: "recall",
      });
      chunksCreated += 1;
    } catch (err) {
      failures.push({
        chunkIdx: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { docId, chunksCreated, parentTracked, failures };
}

// ---------------------------------------------------------------------------
// searchPrecise — exact-substring first, fuzzy token-overlap fallback
// ---------------------------------------------------------------------------

interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length > 0);
}

/** Jaccard-ish overlap: |query ∩ entryTokens| / |queryTokens|. */
function tokenOverlap(queryTokens: string[], entryText: string): number {
  if (queryTokens.length === 0) return 0;
  const entryTokens = new Set(tokenize(entryText));
  let hits = 0;
  for (const q of queryTokens) {
    if (entryTokens.has(q)) hits += 1;
  }
  return hits / queryTokens.length;
}

/**
 * Precise search across project memory entries.
 *
 * Step 1: exact lowercase-substring match — every query word must appear in
 *         (entry.body + " " + entry.description). All hits returned.
 * Step 2: if no exact hits, fuzzy fallback scores all entries by token overlap
 *         and returns top-K with score ≥ scoreThreshold.
 */
export function searchPrecise(
  projectMemory: ProjectMemoryCore,
  query: string,
  opts: PreciseSearchOptions = {},
): PreciseSearchResult {
  const topK = opts.topK ?? 5;
  const scoreThreshold = opts.scoreThreshold ?? 0.1;

  const trimmed = query.trim();
  if (!trimmed || topK <= 0) {
    return { results: [], fallbackUsed: false };
  }

  const indexEntries = projectMemory.listEntries();
  const entries: MemoryEntry[] = [];
  for (const idx of indexEntries) {
    const e = projectMemory.readEntry(idx.name);
    if (e) entries.push(e);
  }

  const lowerQuery = trimmed.toLowerCase();
  const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 0);

  // Step 1: exact-substring containment (all query words present).
  const exactHits: MemoryEntry[] = [];
  for (const e of entries) {
    const haystack = `${e.body} ${e.description}`.toLowerCase();
    const allPresent = queryWords.every((w) => haystack.includes(w));
    if (allPresent) exactHits.push(e);
  }

  if (exactHits.length > 0) {
    return {
      results: exactHits.slice(0, topK),
      fallbackUsed: false,
    };
  }

  // Step 2: fuzzy fallback.
  const queryTokens = tokenize(trimmed);
  const scored: ScoredEntry[] = [];
  for (const e of entries) {
    const haystack = `${e.body} ${e.description}`;
    const score = tokenOverlap(queryTokens, haystack);
    if (score >= scoreThreshold) {
      scored.push({ entry: e, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  return {
    results: scored.slice(0, topK).map((s) => s.entry),
    fallbackUsed: true,
  };
}
