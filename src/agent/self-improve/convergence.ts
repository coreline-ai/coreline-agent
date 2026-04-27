/**
 * Convergence judge — MemKraft convergence.py port.
 * Decides whether N recent iterations stabilised enough to stop.
 * Pure: no I/O, no LLM. Numeric-only.
 *
 * Tier-aware staleness (Phase 13 / C1): when `staleAfterDays` is not explicitly
 * provided, the effective cutoff is `TIER_STALE_DAYS[tier ?? "recall"]`. This
 * means:
 *   - tier "core"     → 180 days
 *   - tier "recall"   → 60 days (default)
 *   - tier "archival" → null (never stale)
 * Callers that already know the entity's tier (e.g. via `tierOf`) may pass it
 * directly; higher-level wrappers live in `tier-aware-convergence.ts`.
 */

import type { EvidenceRecord, ConvergenceVerdict } from "./types.js";
import type { MemoryTier } from "../../memory/types.js";
import { TIER_STALE_DAYS } from "../../memory/constants.js";

export interface CheckConvergenceOptions {
  /** Records for the domain+id (newest-first or any order; function will sort by iteration). */
  records: EvidenceRecord[];
  /** Lookback window. Default 2 (minimum per MemKraft). */
  window?: number;
  /** Max allowed accuracy delta (percentage points). Default 3.0. */
  maxAccDelta?: number;
  /** Max allowed tool-use delta as % of mean. Default 10.0. */
  maxStepsDeltaPct?: number;
  /** Max allowed duration delta as % of mean. Default 15.0. */
  maxDurDeltaPct?: number;
  /**
   * Optional tier for staleness policy. When `staleAfterDays` is not explicitly
   * set, `TIER_STALE_DAYS[tier ?? "recall"]` is used (Phase 13 contract).
   */
  tier?: MemoryTier;
  /** Override stale days (otherwise use TIER_STALE_DAYS[tier ?? "recall"]). */
  staleAfterDays?: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Delta for a single numeric metric across recent records. */
function computeDelta(
  recent: EvidenceRecord[],
  getter: (r: EvidenceRecord) => number | undefined,
): { delta: number | null; deltaPct: number | null; mean: number | null } {
  const values: number[] = [];
  for (const r of recent) {
    const v = getter(r);
    if (typeof v === "number" && Number.isFinite(v)) {
      values.push(v);
    }
  }
  // If fewer than 2 records have the metric defined, insufficient data → delta 0.
  if (values.length < 2) {
    return { delta: 0, deltaPct: 0, mean: values.length === 1 ? values[0] : null };
  }
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  const delta = max - min;
  const deltaPct = mean === 0 ? 0 : (delta / mean) * 100;
  return { delta, deltaPct, mean };
}

function makeVerdict(partial: Partial<ConvergenceVerdict> & {
  converged: boolean;
  reason: ConvergenceVerdict["reason"];
  window: number;
  iterationsChecked: number[];
  suggestedNext: ConvergenceVerdict["suggestedNext"];
}, extras?: Partial<ConvergenceVerdict["metrics"]> & { lastIterationAgeDays?: number | null; tier?: MemoryTier }): ConvergenceVerdict {
  return {
    converged: partial.converged,
    reason: partial.reason,
    window: partial.window,
    iterationsChecked: partial.iterationsChecked,
    suggestedNext: partial.suggestedNext,
    metrics: {
      accuracyDelta: extras?.accuracyDelta ?? null,
      stepsDeltaPct: extras?.stepsDeltaPct ?? null,
      durationDeltaPct: extras?.durationDeltaPct ?? null,
      passRate: extras?.passRate ?? null,
      unclearTotal: extras?.unclearTotal ?? 0,
    },
    lastIterationAgeDays: extras?.lastIterationAgeDays ?? null,
    tier: extras?.tier,
  };
}

export function checkConvergence(options: CheckConvergenceOptions): ConvergenceVerdict {
  const window = Math.max(2, Math.floor(options.window ?? 2));
  const maxAccDelta = options.maxAccDelta ?? 3.0;
  const maxStepsDeltaPct = options.maxStepsDeltaPct ?? 10.0;
  const maxDurDeltaPct = options.maxDurDeltaPct ?? 15.0;
  const tier = options.tier;
  const staleAfterDays =
    options.staleAfterDays !== undefined
      ? options.staleAfterDays
      : TIER_STALE_DAYS[tier ?? "recall"];

  // 1. Sort records by iteration descending (newest-first).
  const sorted = [...options.records].sort((a, b) => b.iteration - a.iteration);

  // 2. Insufficient records.
  if (sorted.length < window) {
    const iterationsChecked = sorted.slice(0, window).map((r) => r.iteration);
    return makeVerdict(
      {
        converged: false,
        reason: "insufficient-iters",
        window,
        iterationsChecked,
        suggestedNext: sorted.length === 0 ? "first-iteration" : "patch-and-iterate",
      },
      { tier },
    );
  }

  // 3. Newest-first window.
  const recent = sorted.slice(0, window);
  const iterationsChecked = recent.map((r) => r.iteration);

  // Common metrics (computed now for embedding in verdicts).
  const passedCount = recent.reduce((acc, r) => acc + (r.outcome.success ? 1 : 0), 0);
  const passRate = (passedCount / recent.length) * 100;
  const unclearTotal = recent.reduce(
    (acc, r) => acc + (r.outcome.unclearPoints?.length ?? 0),
    0,
  );

  // 4. Staleness check.
  const newest = recent[0];
  const newestTs = Date.parse(newest.invokedAt);
  const lastIterationAgeDays = Number.isFinite(newestTs)
    ? (Date.now() - newestTs) / MS_PER_DAY
    : null;
  if (
    staleAfterDays !== null &&
    staleAfterDays !== undefined &&
    lastIterationAgeDays !== null &&
    lastIterationAgeDays > staleAfterDays
  ) {
    return makeVerdict(
      {
        converged: false,
        reason: "stale",
        window,
        iterationsChecked,
        suggestedNext: "re-run",
      },
      {
        passRate,
        unclearTotal,
        lastIterationAgeDays,
        tier,
      },
    );
  }

  // 5. All-passed check.
  if (passedCount < recent.length) {
    return makeVerdict(
      {
        converged: false,
        reason: "not-all-passed",
        window,
        iterationsChecked,
        suggestedNext: "patch-and-iterate",
      },
      {
        passRate,
        unclearTotal,
        lastIterationAgeDays,
        tier,
      },
    );
  }

  // 6. Unclear points check.
  if (unclearTotal > 0) {
    return makeVerdict(
      {
        converged: false,
        reason: "unclear-points",
        window,
        iterationsChecked,
        suggestedNext: "patch-and-iterate",
      },
      {
        passRate,
        unclearTotal,
        lastIterationAgeDays,
        tier,
      },
    );
  }

  // 7. Accuracy delta.
  const accuracy = computeDelta(recent, (r) => r.outcome.accuracy);
  const accuracyDelta = accuracy.delta;
  if (accuracyDelta !== null && accuracyDelta > maxAccDelta) {
    return makeVerdict(
      {
        converged: false,
        reason: "accuracy-delta",
        window,
        iterationsChecked,
        suggestedNext: "patch-and-iterate",
      },
      {
        accuracyDelta,
        passRate,
        unclearTotal,
        lastIterationAgeDays,
        tier,
      },
    );
  }

  // 8. Steps delta %.
  const steps = computeDelta(recent, (r) => r.outcome.toolCalls);
  const stepsDeltaPct = steps.deltaPct;
  if (stepsDeltaPct !== null && stepsDeltaPct > maxStepsDeltaPct) {
    return makeVerdict(
      {
        converged: false,
        reason: "steps-delta",
        window,
        iterationsChecked,
        suggestedNext: "patch-and-iterate",
      },
      {
        accuracyDelta,
        stepsDeltaPct,
        passRate,
        unclearTotal,
        lastIterationAgeDays,
        tier,
      },
    );
  }

  // 9. Duration delta %.
  const duration = computeDelta(recent, (r) => r.outcome.durationMs);
  const durationDeltaPct = duration.deltaPct;
  if (durationDeltaPct !== null && durationDeltaPct > maxDurDeltaPct) {
    return makeVerdict(
      {
        converged: false,
        reason: "duration-delta",
        window,
        iterationsChecked,
        suggestedNext: "patch-and-iterate",
      },
      {
        accuracyDelta,
        stepsDeltaPct,
        durationDeltaPct,
        passRate,
        unclearTotal,
        lastIterationAgeDays,
        tier,
      },
    );
  }

  // 10. Converged.
  return makeVerdict(
    {
      converged: true,
      reason: "converged",
      window,
      iterationsChecked,
      suggestedNext: "stop",
    },
    {
      accuracyDelta,
      stepsDeltaPct,
      durationDeltaPct,
      passRate,
      unclearTotal,
      lastIterationAgeDays,
      tier,
    },
  );
}
