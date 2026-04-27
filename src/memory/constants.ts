/**
 * Memory system constants.
 */

import type { MemoryTier, MemoryType } from "./types.js";

export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MAX_MEMORY_BYTES = 10_000;

export const AGENT_MD_FILENAMES = ["AGENT.md", "CLAUDE.md"] as const;
export const MAX_AGENT_MD_FILE_BYTES = 50 * 1024;
export const MAX_AGENT_MD_TOTAL_BYTES = 200 * 1024;

// ---------------------------------------------------------------------------
// MemKraft 3-tier memory (Phase 0)
// ---------------------------------------------------------------------------

/** Default tier when frontmatter omits `tier` — MemKraft tiers.py:31 compatible. */
export const DEFAULT_TIER: MemoryTier = "recall";

/**
 * Ordering: higher = included first in working_set.
 * MemKraft tiers.py:32 — `{"archival": 0, "recall": 1, "core": 2}`.
 */
export const TIER_ORDER: Record<MemoryTier, number> = {
  archival: 0,
  recall: 1,
  core: 2,
};

/**
 * Per-tier staleness cutoff (days). MemKraft convergence.py:48-52 port.
 * `null` = never stale (archival memory is historical by design).
 */
export const TIER_STALE_DAYS: Record<MemoryTier, number | null> = {
  core: 180,
  recall: 60,
  archival: null,
};

/** Default working_set size — core always included + recall fills remainder. */
export const WORKING_SET_DEFAULT_LIMIT = 8;

/** accessCount threshold for auto-promotion (recall → core). */
export const AUTO_PROMOTE_THRESHOLD = 3;

/** Default type→tier mapping applied by auto-summary when writing new entries. */
export const DEFAULT_TIER_FOR_TYPE: Record<MemoryType, MemoryTier> = {
  user: "core",
  feedback: "core",
  project: "core",
  reference: "recall",
  "brand-spec": "core",
};

// ---------------------------------------------------------------------------
// Wave 7-9 (MemKraft Wave 7/8/9 — bitemporal/decay/links/chunking/incident/decision/rca/runbook)
// ---------------------------------------------------------------------------

/** Default decay rate per applyDecay() call. MemKraft decay.py:191 (must be 0 < rate < 1). */
export const DECAY_DEFAULT_RATE = 0.5;
/** Search/working-set exclusion threshold — entries below this weight are filtered. 0 = disabled (default). */
export const DECAY_MIN_WEIGHT = 0.0;
/** Runtime fallback for `decayWeight` when frontmatter omits the field (D17 — MemKraft parity). */
export const DECAY_DEFAULT_WEIGHT = 1.0;

/** Document chunking — word-level split. MemKraft chunking.py:34-56 defaults. */
export const CHUNK_DEFAULT_SIZE = 500; // words
export const CHUNK_DEFAULT_OVERLAP = 50; // words
/** Hard cap to prevent chunk explosion (10MB doc → 20K chunks scenario). */
export const MAX_CHUNKS_PER_DOC = 1000;

/** Tool failure threshold for auto-incident escalation (Wave 8). */
export const INCIDENT_ESCALATION_THRESHOLD = 3;
/** Default tool→severity mapping when SEVERITY_MAP env doesn't override. */
export const DEFAULT_INCIDENT_SEVERITY: "low" | "medium" | "high" | "critical" = "medium";

/** Runbook auto-apply confidence threshold (Wave 9). MemKraft runbook.py default. */
export const RUNBOOK_AUTO_APPLY_THRESHOLD = 0.8;

/** Wiki-link graph max BFS depth (Wave 7). */
export const LINK_MAX_HOPS = 2;

/** Bitemporal facts: entity-per-file max history entries (warning threshold). */
export const FACTS_MAX_ENTRIES = 500;

