import { describe, expect, test } from "bun:test";
import type { PlanRunRecord } from "../src/session/records.js";
import type { Task, TaskStatus } from "../src/agent/plan-execute/types.js";
import {
  buildResumeAdvice,
  classifyResumeRisk,
  createRecoveryCheckpoint,
} from "../src/agent/reliability/recovery.js";

function task(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
  return {
    id,
    description: `Task ${id}`,
    dependsOn: [],
    status,
    ...extra,
  };
}

function makeRun(partial: Partial<PlanRunRecord> = {}): PlanRunRecord {
  const sessionId = partial.sessionId ?? "session-recovery";
  const planRunId = partial.planRunId ?? "plan-run-1";
  const tasks = partial.plan?.tasks ?? [
    task("task-1", "verified", { verification: { status: "passed", strategy: "deterministic", summary: "ok" } }),
    task("task-2", "failed", { failureReason: "network timeout from provider" }),
  ];

  return {
    _type: "plan_run",
    planRunId,
    sessionId,
    createdAt: partial.createdAt ?? "2026-04-19T00:00:00.000Z",
    mode: partial.mode ?? "autopilot",
    goal: partial.goal ?? "harden single agent",
    activeTaskId: partial.activeTaskId,
    nextAction: partial.nextAction,
    recoveryAction: partial.recoveryAction,
    resumeEligible: partial.resumeEligible,
    lastFailureClass: partial.lastFailureClass,
    lastFailureReason: partial.lastFailureReason,
    stopReason: partial.stopReason,
    decisionLog: partial.decisionLog,
    plan: { goal: partial.goal ?? "harden single agent", tasks },
    steps: partial.steps ?? [],
    status: partial.status ?? "failed",
    completed: partial.completed,
    summary: partial.summary,
    resultText: partial.resultText,
    error: partial.error,
    prompt: partial.prompt,
  };
}

describe("single-agent reliability recovery helpers", () => {
  test("creates advisory do-not-repeat entries for completed and verified tasks", () => {
    const run = makeRun({
      status: "failed",
      lastFailureClass: "failed",
      plan: {
        goal: "ship",
        tasks: [
          task("task-1", "completed"),
          task("task-2", "verified", { verification: { status: "passed", strategy: "deterministic" } }),
          task("task-3", "failed", { failureReason: "provider timeout" }),
        ],
      },
      activeTaskId: "task-3",
    });

    const checkpoint = createRecoveryCheckpoint(run, { createdAt: "2026-04-19T01:00:00.000Z" });

    expect(checkpoint.completedTaskIds).toEqual(["task-1", "task-2"]);
    expect(checkpoint.activeTaskId).toBe("task-3");
    expect(checkpoint.doNotRepeat).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "task-1", reason: "completed_or_verified_task" }),
      expect.objectContaining({ taskId: "task-2", reason: "completed_or_verified_task" }),
    ]));
    expect(checkpoint.suggestedNextAction).toContain("retry");
  });

  test.each([
    {
      status: "needs_user" as const,
      failureClass: "needs_user" as const,
      reason: "Need user confirmation before editing",
      expectedAction: "ask_user" as const,
      expectedRisk: "high" as const,
    },
    {
      status: "blocked" as const,
      failureClass: "blocked" as const,
      reason: "permission denied by policy",
      expectedAction: "ask_user" as const,
      expectedRisk: "high" as const,
    },
    {
      status: "failed" as const,
      failureClass: "failed" as const,
      reason: "provider network timeout",
      expectedAction: "retry" as const,
      expectedRisk: "medium" as const,
    },
    {
      status: "failed" as const,
      failureClass: "failed" as const,
      reason: "unit test assertion failed",
      expectedAction: "replan" as const,
      expectedRisk: "high" as const,
    },
  ])("builds $status resume advice", ({ status, failureClass, reason, expectedAction, expectedRisk }) => {
    const run = makeRun({ status, lastFailureClass: failureClass, lastFailureReason: reason, activeTaskId: "task-2" });
    const checkpoint = createRecoveryCheckpoint(run, { createdAt: "2026-04-19T01:00:00.000Z" });
    const advice = buildResumeAdvice(checkpoint, run);

    expect(advice.action).toBe(expectedAction);
    expect(advice.risk).toBe(expectedRisk);
    expect(advice.fromTaskId).toBe("task-2");
    expect(advice.reason).toContain(reason);
  });

  test("doNotRepeat remains advisory and never exposes enforcement flags", () => {
    const run = makeRun({
      plan: { goal: "ship", tasks: [task("done", "completed"), task("remaining", "pending")] },
      status: "running",
      activeTaskId: "remaining",
    });
    const advice = buildResumeAdvice(createRecoveryCheckpoint(run), run);

    expect(advice.action).toBe("continue");
    expect(advice.doNotRepeat[0]).toMatchObject({ taskId: "done", reason: "completed_or_verified_task" });
    expect(JSON.stringify(advice.doNotRepeat)).not.toContain("block");
    expect(JSON.stringify(advice.doNotRepeat)).not.toContain("deny");
  });

  test("creates duplicate checkpoints with stable ids for the same plan run", () => {
    const run = makeRun({
      status: "blocked",
      lastFailureClass: "blocked",
      lastFailureReason: "hook blocking response",
      activeTaskId: "task-2",
    });

    const first = createRecoveryCheckpoint(run, { createdAt: "2026-04-19T01:00:00.000Z" });
    const second = createRecoveryCheckpoint(run, { createdAt: "2026-04-19T02:00:00.000Z" });

    expect(first.checkpointId).toBe(second.checkpointId);
    expect(first.doNotRepeat).toEqual(second.doNotRepeat);
    expect(first.suggestedNextAction).toBe(second.suggestedNextAction);
  });

  test("reads legacy plan_run records without optional failure fields", () => {
    const run = makeRun({
      status: "running",
      activeTaskId: undefined,
      lastFailureClass: undefined,
      lastFailureReason: undefined,
      plan: { goal: "legacy", tasks: [task("legacy-done", "completed"), task("legacy-next", "pending")] },
      steps: [],
    });

    const checkpoint = createRecoveryCheckpoint(run);
    const advice = buildResumeAdvice(checkpoint, run);

    expect(checkpoint.planRunId).toBe(run.planRunId);
    expect(checkpoint.activeTaskId).toBe("legacy-next");
    expect(advice.action).toBe("continue");
    expect(classifyResumeRisk(checkpoint, run)).toBe("low");
  });

  test("uses autopilot decisionLog as source evidence for repeated failure advice", () => {
    const run = makeRun({
      status: "blocked",
      lastFailureClass: "blocked",
      activeTaskId: "task-2",
      decisionLog: [
        { cycle: 1, kind: "start", reason: "start", createdAt: "2026-04-19T00:00:00.000Z" },
        {
          cycle: 2,
          kind: "stop",
          reason: "same task repeated without progress",
          createdAt: "2026-04-19T00:01:00.000Z",
          taskId: "task-2",
          guardKind: "repeated_failure",
        },
      ],
    });

    const checkpoint = createRecoveryCheckpoint(run);

    expect(checkpoint.doNotRepeat).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "task-2", reason: "autopilot_guard_repeated_failure" }),
    ]));
  });
});
