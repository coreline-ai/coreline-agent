/**
 * Tests for plan-execute convergence gate — Phase 10 A4.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordIterationAndCheck } from "../src/agent/plan-execute/convergence-gate.js";
import type {
  PlanExecutionStep,
  Task,
  EvaluationResult,
} from "../src/agent/plan-execute/types.js";

let tempRoot: string;
const PROJECT_ID = "proj-gate-test";

function makeStep(success: boolean): PlanExecutionStep {
  const task: Task = {
    id: "t1",
    description: "test",
    dependsOn: [],
    status: success ? "completed" : "failed",
  };
  const evaluation: EvaluationResult = {
    success,
    outcome: success ? "success" : "failure",
  };
  return {
    task,
    result: success ? "ok" : "err",
    evaluation,
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "convergence-gate-"));
  delete process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP;
});

describe("recordIterationAndCheck", () => {
  test("3x same PlanExecutionStep (success) → 2nd call already stops (window=2 default)", () => {
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-1",
      planId: "plan-1",
      rootDir: tempRoot,
    };

    const step = makeStep(true);

    const r1 = recordIterationAndCheck(opts, step);
    expect(r1.stop).toBe(false); // only 1 record → insufficient-iters
    expect(r1.verdict.reason).toBe("insufficient-iters");

    const r2 = recordIterationAndCheck(opts, step);
    expect(r2.stop).toBe(true);
    expect(r2.verdict.converged).toBe(true);

    const r3 = recordIterationAndCheck(opts, step);
    expect(r3.stop).toBe(true);
  });

  test("regression (failure) after stable → continues (not-all-passed)", () => {
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-1",
      planId: "plan-regression",
      rootDir: tempRoot,
    };

    const ok = makeStep(true);
    const fail = makeStep(false);

    recordIterationAndCheck(opts, ok);
    const r2 = recordIterationAndCheck(opts, ok);
    expect(r2.stop).toBe(true);

    // Regression in iteration 3 → window = [3, 2] has a failure.
    const r3 = recordIterationAndCheck(opts, fail);
    expect(r3.stop).toBe(false);
    expect(r3.verdict.reason).toBe("not-all-passed");
  });

  test("unconverged (single iteration) → continue", () => {
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-1",
      planId: "plan-single",
      rootDir: tempRoot,
    };

    const r1 = recordIterationAndCheck(opts, makeStep(true));
    expect(r1.stop).toBe(false);
    expect(r1.verdict.converged).toBe(false);
    expect(r1.verdict.reason).toBe("insufficient-iters");
  });

  test("CORELINE_DISABLE_CONVERGENCE_AUTOSTOP=1 → never stops", () => {
    process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP = "1";
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-1",
      planId: "plan-disabled",
      rootDir: tempRoot,
    };

    const step = makeStep(true);
    const r1 = recordIterationAndCheck(opts, step);
    const r2 = recordIterationAndCheck(opts, step);
    const r3 = recordIterationAndCheck(opts, step);
    expect(r1.stop).toBe(false);
    expect(r2.stop).toBe(false);
    expect(r3.stop).toBe(false);
    // Verdict still reflects convergence when possible:
    expect(r2.verdict.converged).toBe(true);
  });
});
