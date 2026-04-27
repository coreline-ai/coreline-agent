/**
 * Self-Improvement Loop types (MemKraft prompt_tune.py + convergence.py port).
 *
 * Evidence records are append-only JSONL logs of skill/subagent/prompt/plan
 * invocations. summariseEval aggregates them; checkConvergence decides whether
 * a domain entity has stabilised enough to stop iterating.
 */

import type { MemoryTier } from "../../memory/types.js";

export type EvidenceDomain = "skill" | "subagent" | "prompt" | "plan-iteration";

/** A single invocation/run of a domain entity (skill, subagent, etc.). */
export interface EvidenceRecord {
  domain: EvidenceDomain;
  /** Stable identifier within the domain: skillId, subagentType, promptName, planId. */
  id: string;
  sessionId: string;
  /** 1-based cumulative iteration within the domain/id tuple. */
  iteration: number;
  /** ISO 8601 timestamp. */
  invokedAt: string;
  outcome: EvidenceOutcome;
  metadata?: Record<string, unknown>;
}

export interface EvidenceOutcome {
  success: boolean;
  /** 0-100 scale, compatible with MemKraft _summarise_results. */
  accuracy?: number;
  turnsUsed?: number;
  toolCalls?: number;
  durationMs?: number;
  unclearPoints?: string[];
  userAccepted?: boolean;
}

/** Aggregated stats over a window of EvidenceRecord — MemKraft _summarise_results port. */
export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  /** Percentage 0-100, or null when total === 0. */
  passRate: number | null;
  /** Mean accuracy across records with numeric accuracy, or null. */
  avgAccuracy: number | null;
  totalToolUses: number;
  avgToolUses: number | null;
  totalDurationMs: number;
  unclearCount: number;
  unclearPoints: string[];
}

/** Result of checkConvergence — stopping-rule verdict. */
export interface ConvergenceVerdict {
  converged: boolean;
  /**
   * `converged` — stable across window.
   * `insufficient-iters` — fewer records than window.
   * `stale` — last iteration older than tier staleAfterDays.
   * `not-all-passed` — at least one record with passRate < 100.
   * `unclear-points` — open unclear items pending.
   * `accuracy-delta` / `steps-delta` / `duration-delta` — metric drift beyond threshold.
   * `decision-load-failed` — evidence read failure (defensive).
   */
  reason:
    | "converged"
    | "insufficient-iters"
    | "stale"
    | "not-all-passed"
    | "unclear-points"
    | "accuracy-delta"
    | "steps-delta"
    | "duration-delta"
    | "decision-load-failed";
  /** Size of the lookback window actually evaluated. */
  window: number;
  /** Iteration numbers inspected, newest-first. */
  iterationsChecked: number[];
  metrics: {
    accuracyDelta: number | null;
    stepsDeltaPct: number | null;
    durationDeltaPct: number | null;
    passRate: number | null;
    unclearTotal: number;
  };
  lastIterationAgeDays: number | null;
  /** `stop` / `first-iteration` / `patch-and-iterate` / `re-run`. */
  suggestedNext: "stop" | "first-iteration" | "patch-and-iterate" | "re-run";
  /** Optional tier used for staleness policy. Undefined defaults to `recall`. */
  tier?: MemoryTier;
}

/** Append result — best-effort write semantics. */
export interface EvidenceAppendResult {
  recorded: boolean;
  error?: string;
}
