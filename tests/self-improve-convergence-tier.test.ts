/** Phase 13 (C1) — tier-aware convergence staleness tests. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConvergence } from "../src/agent/self-improve/convergence.js";
import { checkConvergenceWithTier } from "../src/agent/self-improve/tier-aware-convergence.js";
import type {
  EvidenceOutcome,
  EvidenceRecord,
} from "../src/agent/self-improve/types.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { tierSet } from "../src/memory/tiering.js";

const DAY_MS = 86_400_000;

function makeRecord(
  iteration: number,
  ageDays: number,
  outcome: Partial<EvidenceOutcome> & { success?: boolean } = {},
): EvidenceRecord {
  const { success = true, unclearPoints = [], ...rest } = outcome;
  return {
    domain: "plan-iteration",
    id: "plan-1",
    sessionId: "s-1",
    iteration,
    invokedAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    outcome: { success, unclearPoints, ...rest },
  };
}

/** Delta checks disabled so staleness is the sole failure mode. */
const NO_DELTA_LIMITS = {
  maxAccDelta: 100,
  maxStepsDeltaPct: 100,
  maxDurDeltaPct: 100,
};

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-tier-conv-test-"));
}

describe("checkConvergence — tier-aware staleness (Phase 13)", () => {
  test("TC-13.1: tier=core, last iteration 100 days old → NOT stale (180d cutoff)", () => {
    const records = [
      makeRecord(1, 105, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, 100, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({
      records,
      tier: "core",
      ...NO_DELTA_LIMITS,
    });
    expect(verdict.reason).not.toBe("stale");
    expect(verdict.converged).toBe(true);
    expect(verdict.tier).toBe("core");
  });

  test("TC-13.2: tier=core, 200 days old → stale, suggestedNext=re-run", () => {
    const records = [
      makeRecord(1, 205, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, 200, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({
      records,
      tier: "core",
      ...NO_DELTA_LIMITS,
    });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("stale");
    expect(verdict.suggestedNext).toBe("re-run");
    expect(verdict.tier).toBe("core");
    expect(verdict.lastIterationAgeDays).not.toBeNull();
    expect((verdict.lastIterationAgeDays ?? 0) > 180).toBe(true);
  });

  test("TC-13.3: tier=recall, 70 days old → stale (60d cutoff)", () => {
    const records = [
      makeRecord(1, 75, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, 70, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({
      records,
      tier: "recall",
      ...NO_DELTA_LIMITS,
    });
    expect(verdict.converged).toBe(false);
    expect(verdict.reason).toBe("stale");
    expect(verdict.suggestedNext).toBe("re-run");
    expect(verdict.tier).toBe("recall");
  });

  test("TC-13.4: tier=recall, 30 days old → NOT stale (normal convergence path)", () => {
    const records = [
      makeRecord(1, 35, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, 30, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({
      records,
      tier: "recall",
      ...NO_DELTA_LIMITS,
    });
    expect(verdict.reason).not.toBe("stale");
    expect(verdict.converged).toBe(true);
    expect(verdict.tier).toBe("recall");
  });

  test("TC-13.5: tier=archival, 1000 days old → NOT stale (null cutoff)", () => {
    const records = [
      makeRecord(1, 1005, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      makeRecord(2, 1000, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
    ];
    const verdict = checkConvergence({
      records,
      tier: "archival",
      ...NO_DELTA_LIMITS,
    });
    expect(verdict.reason).not.toBe("stale");
    expect(verdict.converged).toBe(true);
    expect(verdict.tier).toBe("archival");
    expect((verdict.lastIterationAgeDays ?? 0) > 900).toBe(true);
  });

  test("TC-13.6: checkConvergenceWithTier resolves tier=core from ProjectMemory (180d applied)", () => {
    const root = mkTmpRoot();
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-phase13-core", { rootDir: root });
      mem.writeEntry({
        name: "plan-1",
        description: "plan entity",
        type: "project",
        body: "body",
        filePath: "",
      });
      tierSet(mem, "plan-1", "core");

      // 150 days ago: within core's 180d cutoff, would be stale under recall(60d).
      const records = [
        makeRecord(1, 155, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
        makeRecord(2, 150, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      ];

      const verdict = checkConvergenceWithTier({
        projectMemory: mem,
        entityName: "plan-1",
        records,
        ...NO_DELTA_LIMITS,
      });

      expect(verdict.tier).toBe("core");
      expect(verdict.reason).not.toBe("stale");
      expect(verdict.converged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-13.7: checkConvergenceWithTier defaults to recall when entity not registered", () => {
    const root = mkTmpRoot();
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-phase13-missing", { rootDir: root });

      // 70 days old → stale under recall's 60d default.
      const records = [
        makeRecord(1, 75, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
        makeRecord(2, 70, { accuracy: 90, toolCalls: 10, durationMs: 1000 }),
      ];

      const verdict = checkConvergenceWithTier({
        projectMemory: mem,
        entityName: "not-registered",
        records,
        ...NO_DELTA_LIMITS,
      });

      expect(verdict.tier).toBe("recall");
      expect(verdict.converged).toBe(false);
      expect(verdict.reason).toBe("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
