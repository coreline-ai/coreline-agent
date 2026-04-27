/**
 * Aggregate evidence records into an EvalSummary.
 * Port of MemKraft prompt_tune.py::_summarise_results (lines 80-125).
 */

import type { EvalSummary, EvidenceRecord } from "./types.js";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Aggregate a batch of evidence records into stats. Empty input → all zeros/null. */
export function summariseEval(records: readonly EvidenceRecord[]): EvalSummary {
  const total = records.length;
  if (total === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      passRate: null,
      avgAccuracy: null,
      totalToolUses: 0,
      avgToolUses: null,
      totalDurationMs: 0,
      unclearCount: 0,
      unclearPoints: [],
    };
  }

  let passed = 0;
  let accuracySum = 0;
  let accuracyCount = 0;
  let toolSum = 0;
  let toolCount = 0;
  let totalDurationMs = 0;
  const unclearPoints: string[] = [];

  for (const record of records) {
    const outcome = record.outcome;
    if (outcome.success) passed += 1;

    if (typeof outcome.accuracy === "number" && Number.isFinite(outcome.accuracy)) {
      accuracySum += outcome.accuracy;
      accuracyCount += 1;
    }

    if (typeof outcome.toolCalls === "number" && Number.isFinite(outcome.toolCalls)) {
      toolSum += outcome.toolCalls;
      toolCount += 1;
    }

    if (typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs)) {
      totalDurationMs += outcome.durationMs;
    }

    if (Array.isArray(outcome.unclearPoints)) {
      for (const p of outcome.unclearPoints) {
        unclearPoints.push(p);
      }
    }
  }

  const failed = total - passed;
  const passRate = round1((passed / total) * 100);
  const avgAccuracy = accuracyCount > 0 ? round1(accuracySum / accuracyCount) : null;
  const avgToolUses = toolCount > 0 ? round1(toolSum / toolCount) : null;

  return {
    total,
    passed,
    failed,
    passRate,
    avgAccuracy,
    totalToolUses: toolSum,
    avgToolUses,
    totalDurationMs,
    unclearCount: unclearPoints.length,
    unclearPoints,
  };
}
