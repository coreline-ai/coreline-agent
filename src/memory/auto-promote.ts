/** Auto-promotion: recall → core when accessCount >= AUTO_PROMOTE_THRESHOLD. Respects CORELINE_AUTO_PROMOTE=0. */

import { AUTO_PROMOTE_THRESHOLD, DEFAULT_TIER } from "./constants.js";
import { tierList } from "./tiering.js";
import type { MemoryTier, ProjectMemoryCore } from "./types.js";

export interface PromoteOptions {
  projectMemory: ProjectMemoryCore;
  /** Threshold for accessCount → promotion. Default from AUTO_PROMOTE_THRESHOLD. */
  threshold?: number;
  /** Preview without persisting. */
  dryRun?: boolean;
}

export interface PromoteResult {
  promoted: number;
  promotedNames: string[];
  dryRun: boolean;
  skipped?: "disabled";
}

function isDisabled(): boolean {
  return process.env.CORELINE_AUTO_PROMOTE === "0";
}

/**
 * Iterate tierList, promote recall→core when accessCount >= threshold.
 * core/archival entries are untouched. If CORELINE_AUTO_PROMOTE="0", no-op.
 */
export function promoteByAccessCount(options: PromoteOptions): PromoteResult {
  const { projectMemory, threshold = AUTO_PROMOTE_THRESHOLD, dryRun = false } = options;

  if (isDisabled()) {
    return { promoted: 0, promotedNames: [], dryRun: false, skipped: "disabled" };
  }

  const entries = tierList(projectMemory);
  const promotedNames: string[] = [];

  for (const entry of entries) {
    const tier: MemoryTier = entry.tier ?? DEFAULT_TIER;
    if (tier !== "recall") continue;
    const count = entry.accessCount ?? 0;
    if (count < threshold) continue;

    promotedNames.push(entry.name);
    if (!dryRun) {
      projectMemory.writeEntry({ ...entry, tier: "core" });
    }
  }

  return {
    promoted: promotedNames.length,
    promotedNames,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Session tick counter for lifecycle-driven promotion.
// ---------------------------------------------------------------------------

const sessionCounters = new Map<string, number>();

/**
 * Session counter for conditional auto-promote. Exported for testing/orchestration.
 * Call from session-end listener; promotes every N sessions.
 */
export function sessionTickAndMaybePromote(
  projectMemory: ProjectMemoryCore,
  options: { everyN?: number } = {},
): PromoteResult | null {
  const everyN = options.everyN ?? 1;
  if (everyN <= 0) return null;

  const key = projectMemory.projectId;
  const next = (sessionCounters.get(key) ?? 0) + 1;
  sessionCounters.set(key, next);

  if (next % everyN !== 0) {
    return null;
  }

  return promoteByAccessCount({ projectMemory });
}

/**
 * Reset the per-project session counter. Exported for tests/orchestration.
 */
export function resetSessionCounters(): void {
  sessionCounters.clear();
}
