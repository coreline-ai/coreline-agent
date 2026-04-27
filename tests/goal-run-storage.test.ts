import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/paths.js";
import { writeSessionHeader, appendPlanRunRecord, loadPlanRuns, loadLatestResumablePlanRun } from "../src/session/storage.js";
import type { PlanRunRecord } from "../src/session/records.js";
import { formatGoalResumeLines } from "../src/tui/repl.js";

function makePlanRun(partial: Partial<PlanRunRecord> & Pick<PlanRunRecord, "planRunId" | "sessionId" | "goal">): PlanRunRecord {
  return {
    _type: "plan_run",
    planRunId: partial.planRunId,
    sessionId: partial.sessionId,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    mode: partial.mode ?? "goal",
    goal: partial.goal,
    prompt: partial.prompt,
    activeTaskId: partial.activeTaskId,
    nextAction: partial.nextAction,
    recoveryAction: partial.recoveryAction,
    resumeEligible: partial.resumeEligible,
    plan: partial.plan ?? {
      goal: partial.goal,
      tasks: [
        {
          id: "task-1",
          description: "Do the thing",
          dependsOn: [],
          status: "pending",
        },
      ],
    },
    steps: partial.steps ?? [],
    summary: partial.summary,
    completed: partial.completed,
    status: partial.status,
    resultText: partial.resultText,
    error: partial.error,
    lastVerificationSummary: partial.lastVerificationSummary,
    lastFailureClass: partial.lastFailureClass,
    lastFailureReason: partial.lastFailureReason,
    lastRecoveryRationale: partial.lastRecoveryRationale,
    cycleCount: partial.cycleCount,
    stopReason: partial.stopReason,
    decisionLog: partial.decisionLog,
  };
}

describe("goal run storage", () => {
  let tmpDir: string;
  let originalSessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-goal-run-"));
    originalSessionsDir = paths.sessionsDir;
    (paths as { sessionsDir: string }).sessionsDir = tmpDir;
  });

  afterEach(() => {
    (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadPlanRuns returns the latest checkpoint per planRunId", () => {
    const sessionId = "session-goal-run";
    writeSessionHeader(sessionId, { provider: "mock", model: "mock", cwd: process.cwd() });

    appendPlanRunRecord(sessionId, makePlanRun({
      planRunId: "goal-1",
      sessionId,
      goal: "review src",
      createdAt: "2026-04-18T00:00:00.000Z",
      status: "running",
      activeTaskId: "task-1",
      resumeEligible: true,
      lastVerificationSummary: "Verified the current tree is stable.",
      lastFailureClass: "blocked",
      lastFailureReason: "Waiting on dependency resolution.",
      lastRecoveryRationale: "Replan the remaining work.",
    }));

    appendPlanRunRecord(sessionId, makePlanRun({
      planRunId: "goal-1",
      sessionId,
      goal: "review src",
      createdAt: "2026-04-18T00:00:05.000Z",
      status: "needs_user",
      activeTaskId: "task-1",
      nextAction: "ask-user",
      recoveryAction: "ask-user",
      resumeEligible: true,
      lastVerificationSummary: "Verification still points to the same missing input.",
      lastFailureClass: "needs_user",
      lastFailureReason: "Need user confirmation before continuing.",
      lastRecoveryRationale: "Ask the user for clarification.",
    }));

    const runs = loadPlanRuns(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("needs_user");
    expect(runs[0]?.recoveryAction).toBe("ask-user");
    expect(runs[0]?.lastVerificationSummary).toBe("Verification still points to the same missing input.");
    expect(runs[0]?.lastFailureClass).toBe("needs_user");
    expect(runs[0]?.lastFailureReason).toBe("Need user confirmation before continuing.");
    expect(runs[0]?.lastRecoveryRationale).toBe("Ask the user for clarification.");

    const resumeLines = formatGoalResumeLines(runs[0]!);
    expect(resumeLines).toContain("Last verification: Verification still points to the same missing input.");
    expect(resumeLines).toContain("Failure class: needs_user");
    expect(resumeLines).toContain("Failure reason: Need user confirmation before continuing.");
    expect(resumeLines).toContain("Recovery rationale: Ask the user for clarification.");
  });

  test("loadLatestResumablePlanRun prefers the newest resumable goal run", () => {
    const sessionId = "session-goal-resume";
    writeSessionHeader(sessionId, { provider: "mock", model: "mock", cwd: process.cwd() });

    appendPlanRunRecord(sessionId, makePlanRun({
      planRunId: "goal-old",
      sessionId,
      goal: "old goal",
      createdAt: "2026-04-18T00:00:00.000Z",
      status: "failed",
      resumeEligible: true,
    }));

    appendPlanRunRecord(sessionId, makePlanRun({
      planRunId: "goal-new",
      sessionId,
      goal: "new goal",
      createdAt: "2026-04-18T00:00:10.000Z",
      status: "blocked",
      resumeEligible: true,
      activeTaskId: "task-1",
    }));

    appendPlanRunRecord(sessionId, makePlanRun({
      planRunId: "plan-final",
      sessionId,
      goal: "done goal",
      createdAt: "2026-04-18T00:00:20.000Z",
      mode: "plan",
      status: "completed",
      resumeEligible: false,
      completed: true,
    }));

    const latest = loadLatestResumablePlanRun(sessionId);
    expect(latest).not.toBeNull();
    expect(latest?.planRunId).toBe("goal-new");
    expect(latest?.status).toBe("blocked");
  });

  test("loadLatestResumablePlanRun also surfaces autopilot runs", () => {
    const sessionId = "session-autopilot-resume";
    writeSessionHeader(sessionId, { provider: "mock", model: "mock", cwd: process.cwd() });

    appendPlanRunRecord(sessionId, makePlanRun({
      planRunId: "autopilot-run",
      sessionId,
      goal: "ship the fix",
      createdAt: "2026-04-18T00:00:30.000Z",
      mode: "autopilot",
      status: "blocked",
      resumeEligible: true,
      cycleCount: 2,
      stopReason: "same failure repeated 2 times",
    }));

    const latest = loadLatestResumablePlanRun(sessionId);
    expect(latest?.planRunId).toBe("autopilot-run");
    expect(latest?.mode).toBe("autopilot");
    expect(latest?.cycleCount).toBe(2);
    expect(latest?.stopReason).toBe("same failure repeated 2 times");
  });
});
