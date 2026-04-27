import { describe, expect, test } from "bun:test";
import {
  completionInputFromAutopilotRunResult,
  completionInputFromPlanExecutionResult,
  judgeAutopilotCompletion,
  judgeCompletion,
  judgePlanExecutionCompletion,
} from "../src/agent/reliability/completion-judge.js";
import type { AutopilotRunResult } from "../src/agent/plan-execute/autopilot.js";
import type { PlanExecutionResult } from "../src/agent/plan-execute/runner.js";
import type { PlanExecutionStep, Task } from "../src/agent/plan-execute/types.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "task-1",
    description: overrides.description ?? "Do work",
    dependsOn: overrides.dependsOn ?? [],
    status: overrides.status ?? "pending",
    ...overrides,
  };
}

function step(taskInput: Task, success = true): PlanExecutionStep {
  return {
    task: taskInput,
    result: { ok: success },
    evaluation: {
      success,
      outcome: success ? "success" : "failure",
      reason: success ? "verification passed" : "verification failed",
      strategy: "deterministic",
    },
  };
}

function planResult(tasks: Task[], steps: PlanExecutionStep[] = [], completed = false): PlanExecutionResult {
  return {
    plan: { goal: "goal", tasks },
    steps,
    summary: {
      completed: tasks.filter((item) => item.status === "completed" || item.status === "verified").length,
      failed: tasks.filter((item) => item.status === "failed").length,
      ambiguous: 0,
    },
    completed,
  };
}

describe("CompletionJudge", () => {
  test("marks all verified tasks with evidence as completed", () => {
    const verified = task({
      id: "verify",
      status: "verified",
      verification: { status: "passed", strategy: "deterministic", summary: "tests passed" },
    });

    const decision = judgeCompletion({ tasks: [verified] });

    expect(decision.outcome).toBe("completed");
    expect(decision.confidence).toBe("high");
    expect(decision.evidence.some((item) => item.kind === "verification" && item.status === "passed")).toBe(true);
  });

  test("returns partial when tasks completed but verification evidence is missing", () => {
    const done = task({ id: "done", status: "completed" });

    const decision = judgeCompletion({ tasks: [done], completed: true });

    expect(decision.outcome).toBe("partial");
    expect(decision.missingEvidence).toContain("verification evidence");
  });

  test("returns partial for unfinished tasks without failures", () => {
    const done = task({ id: "done", status: "completed", verification: { status: "passed", strategy: "deterministic" } });
    const pending = task({ id: "pending", status: "pending" });

    const decision = judgeCompletion({ tasks: [done, pending] });

    expect(decision.outcome).toBe("partial");
    expect(decision.reason).toContain("pending");
  });

  test("prioritizes aborted over other outcomes", () => {
    const decision = judgeCompletion({
      tasks: [
        task({ id: "aborted", status: "aborted", failureReason: "SIGINT" }),
        task({ id: "needs", status: "needs_user" }),
        task({ id: "blocked", status: "blocked" }),
        task({ id: "failed", status: "failed" }),
      ],
    });

    expect(decision.outcome).toBe("aborted");
  });

  test("prioritizes needs_user over blocked and failed", () => {
    const decision = judgeCompletion({
      tasks: [
        task({ id: "needs", status: "needs_user", nextAction: "confirm change" }),
        task({ id: "blocked", status: "blocked" }),
        task({ id: "failed", status: "failed" }),
      ],
    });

    expect(decision.outcome).toBe("needs_user");
    expect(decision.recommendedNextAction).toContain("confirm change");
  });

  test("classifies permission denied and hook blocking as blocked", () => {
    const permission = judgeCompletion({
      signals: [{ kind: "permission_denied", summary: "FileWrite denied" }],
    });
    const hook = judgeCompletion({
      signals: [{ kind: "hook_blocked", summary: "PreTool hook blocked command" }],
    });

    expect(permission.outcome).toBe("blocked");
    expect(hook.outcome).toBe("blocked");
  });

  test("returns failed for failed task without recovery evidence", () => {
    const decision = judgeCompletion({
      tasks: [task({ id: "failed", status: "failed", failureReason: "tests failed" })],
    });

    expect(decision.outcome).toBe("failed");
    expect(decision.reason).toContain("tests failed");
  });

  test("returns unknown when no useful evidence exists", () => {
    const decision = judgeCompletion({});

    expect(decision.outcome).toBe("unknown");
    expect(decision.confidence).toBe("low");
    expect(decision.missingEvidence).toContain("task status");
  });

  test("adapts PlanExecutionResult input", () => {
    const verified = task({ id: "verify", status: "verified" });
    const result = planResult([verified], [step(verified)], true);

    expect(completionInputFromPlanExecutionResult(result).tasks).toHaveLength(1);
    expect(judgePlanExecutionCompletion(result).outcome).toBe("completed");
  });

  test("adapts AutopilotRunResult input", () => {
    const verified = task({
      id: "verify",
      status: "verified",
      verification: { status: "passed", strategy: "deterministic", summary: "passed" },
    });
    const result = planResult([verified], [step(verified)], true);
    const autopilot: AutopilotRunResult = {
      result,
      latestPlan: result.plan,
      cycleCount: 1,
      stopStatus: "completed",
      stopReason: "goal completed and verified",
      decisionLog: [{ cycle: 1, kind: "stop", reason: "goal completed and verified", createdAt: new Date(0).toISOString() }],
    };

    expect(completionInputFromAutopilotRunResult(autopilot).stopStatus).toBe("completed");
    expect(judgeAutopilotCompletion(autopilot).outcome).toBe("completed");
  });
});
