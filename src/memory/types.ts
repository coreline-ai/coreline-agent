/**
 * Memory domain types.
 */

export type MemoryType = "user" | "feedback" | "project" | "reference" | "brand-spec";

/**
 * 3-tier memory classification (MemKraft tiers.py port).
 *
 * - `core`     — always injected into system prompt (hot working set).
 * - `recall`   — default tier; loaded on demand via working_set selector.
 * - `archival` — cold; excluded from working set, retrievable only by explicit search.
 *
 * Memories without an explicit `tier` field are treated as `recall` by default
 * (see DEFAULT_TIER in constants.ts). No auto-assignment on read.
 */
export type MemoryTier = "core" | "recall" | "archival";

export type MemoryImportance = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Memory Scope (v2)
// ---------------------------------------------------------------------------

export type MemoryScope = "project" | "global";

export type GlobalMemoryType =
  | "preference"
  | "workflow"
  | "environment"
  | "feedback"
  | "reference";

export interface GlobalMemoryProvenance {
  source: "manual" | "memory_tool" | "auto_summary_candidate";
  sessionId?: string;
  projectId?: string;
  cwd?: string;
}

export interface GlobalUserMemoryEntry {
  name: string;
  type: GlobalMemoryType;
  description: string;
  body: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  provenance: GlobalMemoryProvenance;
}

export interface GlobalUserMemoryCore {
  readonly memoryDir: string;

  loadAll(): GlobalUserMemoryEntry[];
  listEntries(): GlobalUserMemoryEntry[];
  readEntry(name: string): GlobalUserMemoryEntry | null;
  writeEntry(entry: Omit<GlobalUserMemoryEntry, "filePath" | "updatedAt"> & { updatedAt?: string }): void;
  deleteEntry(name: string): boolean;
}

export interface MemoryLoadResult {
  globalEntries: GlobalUserMemoryEntry[];
  projectEntries: MemoryEntry[];
  precedence: "prompt > project_instructions > project_memory > global_memory > defaults";
}

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  filePath: string;
  /** Memory tier (MemKraft 3-tier). Undefined = `recall` by default. */
  tier?: MemoryTier;
  /** ISO date (YYYY-MM-DD) of last access. Used by working_set recency sort and compaction. */
  lastAccessed?: string;
  /** Cumulative access count — bumped by tierTouch. Triggers auto-promotion at AUTO_PROMOTE_THRESHOLD. */
  accessCount?: number;
  /** Priority hint for compaction. `low` + 30 days → archival. */
  importance?: MemoryImportance;

  // ---------------------------------------------------------------------------
  // Wave 7 Phase 0: Decay + Tombstone (MemKraft decay.py port)
  // ---------------------------------------------------------------------------
  /** Decay weight ∈ [0, 1]. Undefined = 1.0 at runtime (D17). 0 = fully decayed. */
  decayWeight?: number;
  /** Times decay has been applied. Undefined = 0. */
  decayCount?: number;
  /** Soft-delete marker — file moved to `.memory/tombstones/`. Restorable via decayRestore. */
  tombstoned?: boolean;
  /** ISO timestamp when tombstoned. */
  tombstonedAt?: string;

  // ---------------------------------------------------------------------------
  // Wave 7 Phase 0: Bitemporal frontmatter fields (also used by Incident/Decision)
  // Schema-only — does NOT use Bitemporal Facts API; Incident/Decision/Runbook
  // store these as values to record temporal validity.
  // ---------------------------------------------------------------------------
  /** When the fact was/is true in reality (YYYY-MM-DD or ISO). */
  validFrom?: string;
  /** End of validity (open interval if undefined). */
  validTo?: string;
  /** ISO timestamp when this entry was learned/recorded (distinct from validFrom). */
  recordedAt?: string;
}

export interface MemoryIndexEntry {
  name: string;
  description: string;
  type: MemoryType;
  file: string;
}

export interface AgentMdFile {
  path: string;
  content: string;
}

export interface ProjectMemorySnapshot {
  agentMd: string;
  memoryIndex: string;
  entries: MemoryEntry[];
}

export interface ProjectMetadata {
  cwd: string;
  projectId: string;
  createdAt: string;
  lastAccessedAt: string;
}

export interface ProjectMemoryCore {
  readonly cwd: string;
  readonly projectId: string;
  readonly projectDir: string;
  readonly memoryDir: string;
  readonly metadataPath: string;

  loadAll(): ProjectMemorySnapshot;
  listEntries(): MemoryIndexEntry[];
  readEntry(name: string): MemoryEntry | null;
  writeEntry(entry: MemoryEntry): void;
  deleteEntry(name: string): boolean;
}

