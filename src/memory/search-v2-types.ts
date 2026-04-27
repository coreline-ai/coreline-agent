/**
 * Search v2 — types for searchTemporal, searchExpand, and unified searchV2.
 */

export type SearchSortBy = "relevance" | "recency";
export type SearchDomain = "memory" | "session" | "all";

export interface SearchV2Options {
  query: string;
  projectId: string;
  rootDir?: string;
  /** Sort criterion. Default "relevance". */
  sortBy?: SearchSortBy;
  /** Domains to include. Default "all". */
  domain?: SearchDomain;
  /** Top N results. Default 10. */
  topK?: number;
  /** Min similarity threshold. Default 0.2. */
  scoreThreshold?: number;
  /** Reference "now" for deterministic tests. Default Date.now(). */
  now?: number;
}

export interface SearchV2Hit {
  source: "memory" | "session";
  /** Entity name (memory) or sessionId (session). */
  id: string;
  /** Display title or summary. */
  title: string;
  /** Body preview (first 200 chars). */
  preview: string;
  /** Similarity score [0..1]. */
  score: number;
  /** Recency weight applied (if any). */
  recencyWeight?: number;
  /** Final ranking score (after sortBy). */
  rankingScore: number;
  /** Domain-specific metadata. */
  metadata?: Record<string, unknown>;
}

export interface SearchV2Result {
  query: string;
  totalMatched: number;
  results: SearchV2Hit[];
  domains: { memory: number; session: number };
}

export interface DateHint {
  /** Anchor date (parsed from natural language). */
  anchorDate: Date;
  /** Window width in days (e.g., "last week" → 7). */
  windowDays: number;
  /** Boost factor [1..3]. Default 2. */
  boostFactor: number;
}
