/** Tier-aware convergence wrapper — resolves entity tier from ProjectMemory and applies tier-specific staleness policy. */

import type { ProjectMemoryCore } from "../../memory/types.js";
import type { EvidenceRecord, ConvergenceVerdict } from "./types.js";
import { tierOf } from "../../memory/tiering.js";
import { checkConvergence } from "./convergence.js";

export interface TierAwareCheckOptions {
  projectMemory: ProjectMemoryCore;
  /** Entity name to look up tier. */
  entityName: string;
  records: EvidenceRecord[];
  window?: number;
  maxAccDelta?: number;
  maxStepsDeltaPct?: number;
  maxDurDeltaPct?: number;
}

/**
 * Thin adapter around `checkConvergence` that resolves the entity's tier from
 * ProjectMemory and forwards it. Staleness cutoff is derived automatically via
 * `TIER_STALE_DAYS[tier]` inside `checkConvergence`.
 *
 * If the entity is not registered in ProjectMemory, `tierOf` returns "recall"
 * (the Phase 1 default contract), so the 60-day cutoff applies.
 */
export function checkConvergenceWithTier(
  options: TierAwareCheckOptions,
): ConvergenceVerdict {
  const tier = tierOf(options.projectMemory, options.entityName);
  return checkConvergence({
    records: options.records,
    window: options.window,
    maxAccDelta: options.maxAccDelta,
    maxStepsDeltaPct: options.maxStepsDeltaPct,
    maxDurDeltaPct: options.maxDurDeltaPct,
    tier,
  });
}
