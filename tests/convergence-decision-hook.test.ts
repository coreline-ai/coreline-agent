/**
 * Phase 7 (Wave 9) — Convergence → auto-record decision hook (C2).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordIterationAndCheck } from "../src/agent/plan-execute/convergence-gate.js";
import { decisionSearch } from "../src/agent/decision/decision-store.js";
import type {
  EvaluationResult,
  PlanExecutionStep,
  Task,
} from "../src/agent/plan-execute/types.js";

const PROJECT_ID = "p-conv-hook";

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

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "conv-hook-"));
  delete process.env.AUTO_RECORD_DECISIONS;
  delete process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.AUTO_RECORD_DECISIONS;
  delete process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP;
});

describe("Convergence → auto-record decision hook (C2)", () => {
  test("TC-7.E1: verdict.converged=true → decision recorded with source:auto-convergence", () => {
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-1",
      planId: "plan-conv-1",
      rootDir: tempRoot,
    };
    const step = makeStep(true);
    const r1 = recordIterationAndCheck(opts, step);
    expect(r1.verdict.converged).toBe(false);

    const r2 = recordIterationAndCheck(opts, step);
    expect(r2.verdict.converged).toBe(true);

    const decs = decisionSearch(PROJECT_ID, {}, tempRoot);
    expect(decs.length).toBeGreaterThanOrEqual(1);
    const autoRec = decs.find((d) => d.source === "auto-convergence");
    expect(autoRec).toBeDefined();
    expect(autoRec!.title).toContain("plan-conv-1");
    expect(autoRec!.tags).toContain("plan-execute");
    expect(autoRec!.tags).toContain("auto-record");
  });

  test("TC-7.E2: verdict.converged=false → no decision recorded", () => {
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-2",
      planId: "plan-no-conv",
      rootDir: tempRoot,
    };
    const r1 = recordIterationAndCheck(opts, makeStep(true));
    expect(r1.verdict.converged).toBe(false);

    const decs = decisionSearch(PROJECT_ID, {}, tempRoot);
    expect(decs.length).toBe(0);
  });

  test("TC-7.E3: AUTO_RECORD_DECISIONS=false → no decision recorded even on convergence", () => {
    process.env.AUTO_RECORD_DECISIONS = "false";
    const opts = {
      projectId: PROJECT_ID,
      sessionId: "s-3",
      planId: "plan-disabled",
      rootDir: tempRoot,
    };
    const step = makeStep(true);
    recordIterationAndCheck(opts, step);
    const r2 = recordIterationAndCheck(opts, step);
    expect(r2.verdict.converged).toBe(true);

    const decs = decisionSearch(PROJECT_ID, {}, tempRoot);
    expect(decs.length).toBe(0);
  });
});
