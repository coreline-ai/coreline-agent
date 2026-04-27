/**
 * Tests for summariseEval — Phase 5 A1 (MemKraft _summarise_results port).
 */

import { describe, expect, test } from "bun:test";
import { summariseEval } from "../src/agent/self-improve/eval.js";
import type { EvidenceRecord } from "../src/agent/self-improve/types.js";

function makeRecord(overrides: Partial<EvidenceRecord> & { success?: boolean }): EvidenceRecord {
  const { success = true, ...rest } = overrides;
  return {
    domain: "skill",
    id: "dev-plan",
    sessionId: "s-1",
    iteration: 1,
    invokedAt: new Date().toISOString(),
    outcome: { success },
    ...rest,
  };
}

describe("summariseEval", () => {
  test("TC-5.4 empty input → total=0, passRate=null", () => {
    const result = summariseEval([]);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.passRate).toBeNull();
    expect(result.avgAccuracy).toBeNull();
    expect(result.totalToolUses).toBe(0);
    expect(result.avgToolUses).toBeNull();
    expect(result.totalDurationMs).toBe(0);
    expect(result.unclearCount).toBe(0);
    expect(result.unclearPoints).toEqual([]);
  });

  test("TC-5.1 single record → total=1 and passed/failed correct", () => {
    const result = summariseEval([makeRecord({ success: true })]);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.passRate).toBe(100);
  });

  test("TC-5.3 3 success + 2 fail → passRate=60", () => {
    const records: EvidenceRecord[] = [
      makeRecord({ success: true }),
      makeRecord({ success: true }),
      makeRecord({ success: true }),
      makeRecord({ success: false }),
      makeRecord({ success: false }),
    ];
    const result = summariseEval(records);
    expect(result.total).toBe(5);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.passRate).toBe(60);
  });

  test("TC-5.7 unclearPoints aggregation → unclearCount=2 from [[a],[b]]", () => {
    const result = summariseEval([
      makeRecord({ outcome: { success: true, unclearPoints: ["a"] } }),
      makeRecord({ outcome: { success: false, unclearPoints: ["b"] } }),
    ]);
    expect(result.unclearCount).toBe(2);
    expect(result.unclearPoints).toEqual(["a", "b"]);
  });

  test("all-success → passRate=100", () => {
    const records = [
      makeRecord({ success: true }),
      makeRecord({ success: true }),
      makeRecord({ success: true }),
    ];
    const result = summariseEval(records);
    expect(result.passRate).toBe(100);
    expect(result.failed).toBe(0);
  });

  test("all-fail → passRate=0", () => {
    const records = [makeRecord({ success: false }), makeRecord({ success: false })];
    const result = summariseEval(records);
    expect(result.passRate).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(2);
  });

  test("accuracy averaging ignores missing values", () => {
    const records = [
      makeRecord({ outcome: { success: true, accuracy: 80 } }),
      makeRecord({ outcome: { success: true, accuracy: 60 } }),
      makeRecord({ outcome: { success: true } }),
    ];
    const result = summariseEval(records);
    expect(result.avgAccuracy).toBe(70);
  });

  test("toolCalls sum and duration sum", () => {
    const records = [
      makeRecord({ outcome: { success: true, toolCalls: 3, durationMs: 1_000 } }),
      makeRecord({ outcome: { success: true, toolCalls: 5, durationMs: 2_500 } }),
      makeRecord({ outcome: { success: true } }),
    ];
    const result = summariseEval(records);
    expect(result.totalToolUses).toBe(8);
    expect(result.avgToolUses).toBe(4);
    expect(result.totalDurationMs).toBe(3_500);
  });
});
