/**
 * Tests for checkConvergence — Phase 10 A4 (MemKraft convergence.py port).
 */

import { describe, expect, test } from "bun:test";
import { checkConvergence } from "../src/agent/self-improve/convergence.js";
import type {
  EvidenceOutcome,
  EvidenceRecord,
} from "../src/agent/self-improve/types.js";

function makeRecord(
  iteration: number,
  outcome: Partial<EvidenceOutcome> & { success?: boolean } = {},
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  const { success = true, ...rest } = outcome;
  return {
    domain: "plan-iteration",
    id: "plan-1",
    sessionId: "s-1",
    iteration,
    invokedAt: new Date().toISOString(),
    outcome: { success, ...rest },
    ...overrides,
  };
}

describe("checkConvergence", () => {
  test("TC-10.1 2 iterations, all success, unclear=0, deltas=0 → converged:true", () => {
    const records = [
      makeRecord(1, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(true);
    expect(verdict.reason).toBe("converged");
    expect(verdict.suggestedNext).toBe("stop");
    expect(verdict.metrics.passRate).toBe(100);
  });

  test("TC-10.2 1 iteration → insufficient-iters", () => {
    const records = [makeRecord(1, { success: true })];
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("insufficient-iters");
    expect(verdict.suggestedNext).toBe("patch-and-iterate");
    expect(verdict.iterationsChecked).toEqual([1]);
  });

  test("TC-10.3 acc delta 5pp (limit 3) → accuracy-delta", () => {
    const records = [
      makeRecord(1, { success: true, accuracy: 85 }),
      makeRecord(2, { success: true, accuracy: 90 }),
    ];
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("accuracy-delta");
    expect(verdict.metrics.accuracyDelta).toBe(5);
  });

  test("TC-10.4 passRate < 100 → not-all-passed", () => {
    const records = [
      makeRecord(1, { success: true }),
      makeRecord(2, { success: false }),
    ];
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("not-all-passed");
    expect(verdict.suggestedNext).toBe("patch-and-iterate");
    expect(verdict.metrics.passRate).toBe(50);
  });

  test("TC-10.5 unclear=1 → unclear-points", () => {
    const records = [
      makeRecord(1, { success: true, unclearPoints: ["foo"] }),
      makeRecord(2, { success: true }),
    ];
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("unclear-points");
    expect(verdict.metrics.unclearTotal).toBe(1);
  });

  test("TC-10.6 tool delta 20% (limit 10) → steps-delta", () => {
    const records = [
      makeRecord(1, { success: true, toolCalls: 10 }),
      makeRecord(2, { success: true, toolCalls: 12 }),
    ];
    // mean = 11, delta = 2, deltaPct ≈ 18.18 > 10.
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("steps-delta");
    expect(verdict.metrics.stepsDeltaPct).toBeGreaterThan(10);
  });

  test("TC-10.7 duration delta 20% (limit 15) → duration-delta", () => {
    const records = [
      makeRecord(1, { success: true, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, { success: true, toolCalls: 10, durationMs: 1200 }),
    ];
    // mean=1100, delta=200 → ~18.18% > 15.
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("duration-delta");
    expect(verdict.metrics.durationDeltaPct).toBeGreaterThan(15);
  });

  test("TC-10.8 window=3, 3 stable records → converged", () => {
    const records = [
      makeRecord(1, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(3, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({ records, window: 3 });
    expect(verdict.converged).toBe(true);
    expect(verdict.reason).toBe("converged");
    expect(verdict.iterationsChecked).toEqual([3, 2, 1]);
    expect(verdict.window).toBe(3);
  });

  test("TC-10.E1 records=[] → insufficient-iters, suggestedNext:first-iteration", () => {
    const verdict = checkConvergence({ records: [] });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("insufficient-iters");
    expect(verdict.suggestedNext).toBe("first-iteration");
    expect(verdict.iterationsChecked).toEqual([]);
  });

  test("TC-10.E2 regression in old iter + stable last 2 → converged (window only looks at newest 2)", () => {
    const records = [
      makeRecord(1, { success: false, accuracy: 50 }),
      makeRecord(2, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(3, { success: true, accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({ records });
    expect(verdict.converged).toBe(true);
    expect(verdict.reason).toBe("converged");
    expect(verdict.iterationsChecked).toEqual([3, 2]);
  });
});
