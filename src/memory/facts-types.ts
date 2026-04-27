/**
 * Bitemporal Fact Layer types — Wave 7 Phase 1.
 *
 * Tracks facts with both *valid_time* (when the fact was actually true in the
 * real world) and *record_time* (when we learned / recorded it). Stored as
 * Markdown bullet lines under `<memoryDir>/facts/<entity-slug>.md`.
 */

/** Bitemporal fact record — value at valid_time, learned at recorded_at. */
export interface FactRecord {
  key: string;
  value: string;
  /** YYYY-MM-DD or ISO timestamp; undefined = open-start (-infinity). */
  validFrom?: string;
  /** YYYY-MM-DD or ISO timestamp; undefined = open-end (still valid). */
  validTo?: string;
  /** ISO timestamp (always set) — when the fact was recorded/learned. */
  recordedAt: string;
}

/** Result of a best-effort fact write — never throws on I/O failure. */
export interface FactWriteResult {
  written: boolean;
  filePath?: string;
  error?: string;
}
