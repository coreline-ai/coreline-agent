/**
 * TUI plan-mode tests — slash command entry + session plan restore helpers.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/paths.js";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import { formatPlanRunLines } from "../src/tui/repl.js";
import { SessionManager } from "../src/session/history.js";
import type { PlanRunRecord } from "../src/session/records.js";
import { findLatestResumableGoalRun, formatGoalResumeLines } from "../src/tui/repl.js";

describe("TUI plan-mode", () => {
  let tmpDir: string;
  let originalSessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-plan-mode-"));
    originalSessionsDir = paths.sessionsDir;
    (paths as { sessionsDir: string }).sessionsDir = tmpDir;
  });

  afterEach(() => {
    (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("slash command routes /plan into a controlled plan-mode entry", () => {
    expect(handleSlashCommand("/plan review src")).toEqual({
      handled: true,
      action: "plan",
      data: "review src",
    });

    expect(handleSlashCommand("/plan")).toEqual({
      handled: true,
      output: "Usage: /plan <goal>",
    });
  });

  test("slash command routes /goal into a controlled goal-mode entry", () => {
    expect(handleSlashCommand("/goal improve task flow")).toEqual({
      handled: true,
      action: "goal",
      data: "improve task flow",
    });

    expect(handleSlashCommand("/goal")).toEqual({
      handled: true,
      output: "Usage: /goal <goal>",
    });
  });

  test("slash command routes /autopilot into a controlled autopilot entry", () => {
    expect(handleSlashCommand("/autopilot ship the fix")).toEqual({
      handled: true,
      action: "autopilot",
      data: "ship the fix",
    });

    expect(handleSlashCommand("/autopilot")).toEqual({
      handled: true,
      output: "Usage: /autopilot <goal>",
    });
  });

  test("saved plan runs can be restored and rendered as readable history", () => {
    const session = new SessionManager({
      providerName: "mock",
      model: "mock-model",
    });

    const planRun: PlanRunRecord = {
      _type: "plan_run",
      planRunId: "plan-1",
      sessionId: session.sessionId,
      createdAt: "2026-04-17T00:00:00.000Z",
      source: "tui",
      cwd: process.cwd(),
      providerName: "mock",
      model: "mock-model",
      prompt: "review src",
      goal: "review src",
      plan: {
        goal: "review src",
        tasks: [
          { id: "task-1", description: "Inspect src", dependsOn: [], status: "completed" },
          { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "completed" },
        ],
      },
      steps: [
        {
          task: { id: "task-1", description: "Inspect src", dependsOn: [], status: "completed" },
          result: "Looked through the tree.",
          evaluation: { success: true, outcome: "success", reason: "done" },
        },
        {
          task: { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "completed" },
          result: "All checks passed.",
          evaluation: { success: true, outcome: "success", reason: "done" },
        },
      ],
      summary: { completed: 2, failed: 0, ambiguous: 0 },
      completed: true,
      status: "completed",
      resultText: "Plan: review src\nStatus: completed (completed=2, failed=0, verified=0, ambiguous=0)",
    };

    session.savePlanRun(planRun);

    const loadedRuns = session.loadPlanRuns();
    expect(loadedRuns).toHaveLength(1);
    expect(loadedRuns[0]).toMatchObject({
      planRunId: "plan-1",
      goal: "review src",
      completed: true,
      status: "completed",
    });

    const lines = formatPlanRunLines(loadedRuns[0]!);
    expect(lines[0]).toBe("Plan: review src");
    expect(lines).toContain("Status: completed (completed=2, failed=0, verified=0, ambiguous=0)");
    expect(lines).toContain("  ✓ task-1: Inspect src — Looked through the tree.");
    expect(lines).toContain("  ✓ task-2: Summarize findings — All checks passed.");
  });

  test("resumable goal runs are surfaced as goal-mode read models", () => {
    const goalRun: PlanRunRecord = {
      _type: "plan_run",
      planRunId: "goal-1",
      sessionId: "session-1",
      createdAt: "2026-04-18T00:00:00.000Z",
      mode: "goal",
      resumeEligible: true,
      source: "tui",
      cwd: process.cwd(),
      providerName: "mock",
      model: "mock-model",
      prompt: "ship the fix",
      goal: "ship the fix",
      plan: {
        goal: "ship the fix",
        tasks: [
          { id: "task-1", description: "Inspect", dependsOn: [], status: "running" },
        ],
      },
      steps: [
        {
          task: { id: "task-1", description: "Inspect", dependsOn: [], status: "running" },
          result: "still working",
          evaluation: { success: false, outcome: "ambiguous", reason: "needs more evidence" },
        },
      ],
      summary: { completed: 0, failed: 0, ambiguous: 1 },
      completed: false,
      status: "needs_user",
      activeTaskId: "task-1",
      nextAction: "continue inspection",
      lastVerificationSummary: "Verified the plan step still needs more data.",
      lastFailureClass: "needs_user",
      lastFailureReason: "Need the user to point at the target directory.",
      lastRecoveryRationale: "Ask the user for the missing path.",
    };

    const latestGoalRun = findLatestResumableGoalRun([goalRun]);
    expect(latestGoalRun?.planRunId).toBe("goal-1");

    const goalLines = formatPlanRunLines(goalRun);
    expect(goalLines[0]).toBe("Goal (needs user): ship the fix");
    expect(goalLines).toContain("Last verification: Verified the plan step still needs more data.");
    expect(goalLines).toContain("Failure class: needs_user");
    expect(goalLines).toContain("Failure reason: Need the user to point at the target directory.");
    expect(goalLines).toContain("Recovery rationale: Ask the user for the missing path.");

    const lines = formatGoalResumeLines(goalRun);
    expect(lines[0]).toBe("Goal: ship the fix");
    expect(lines).toContain("Status: needs_user (completed=0, failed=0, verified=0, ambiguous=1)");
    expect(lines).toContain("Last verification: Verified the plan step still needs more data.");
    expect(lines).toContain("Failure class: needs_user");
    expect(lines).toContain("Failure reason: Need the user to point at the target directory.");
    expect(lines).toContain("Recovery rationale: Ask the user for the missing path.");
    expect(lines).toContain("Active task: task-1");
    expect(lines).toContain("Next action: continue inspection");
    expect(lines).toContain("Resume hint: /goal ship the fix");
  });

  test("resumable autopilot runs are surfaced with stop reason and cycle count", () => {
    const autopilotRun: PlanRunRecord = {
      _type: "plan_run",
      planRunId: "autopilot-1",
      sessionId: "session-1",
      createdAt: "2026-04-18T00:00:00.000Z",
      mode: "autopilot",
      resumeEligible: true,
      source: "tui",
      cwd: process.cwd(),
      providerName: "mock",
      model: "mock-model",
      prompt: "ship the fix",
      goal: "ship the fix",
      cycleCount: 2,
      stopReason: "same failure repeated 2 times for task-1",
      decisionLog: [
        {
          cycle: 1,
          kind: "start",
          reason: "start autopilot from goal input",
          createdAt: "2026-04-18T00:00:00.000Z",
        },
      ],
      plan: {
        goal: "ship the fix",
        tasks: [
          { id: "task-1", description: "Inspect", dependsOn: [], status: "blocked" },
        ],
      },
      steps: [
        {
          task: { id: "task-1", description: "Inspect", dependsOn: [], status: "blocked" },
          result: "service unavailable",
          evaluation: { success: false, outcome: "failure", reason: "service unavailable" },
        },
      ],
      summary: { completed: 0, failed: 0, ambiguous: 0, verified: 0 },
      completed: false,
      status: "blocked",
    };

    const lines = formatGoalResumeLines(autopilotRun);
    expect(lines[0]).toBe("Autopilot: ship the fix");
    expect(lines).toContain("Cycles: 2");
    expect(lines).toContain("Stop reason: same failure repeated 2 times for task-1");
    expect(lines).toContain("Resume hint: /autopilot ship the fix");
  });
});
