import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParallelAgentScheduler } from "../src/agent/parallel/scheduler.js";
import { shouldAutoRunVerifier, startAutoVerifier } from "../src/agent/auto-verifier.js";

function createPackageFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "coreline-auto-verifier-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    private: true,
    scripts: {
      typecheck: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    },
  }, null, 2));
  return cwd;
}

describe("auto verifier", () => {
  test("is disabled by default even for completed runs", () => {
    const decision = shouldAutoRunVerifier({
      cwd: process.cwd(),
      provider: "test-provider",
      planRun: { mode: "autopilot", status: "completed", completed: true },
    });

    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("disabled");
  });

  test("only allows successful completed plan/goal/autopilot runs", () => {
    const scheduler = new ParallelAgentScheduler();
    const base = {
      enabled: true,
      cwd: process.cwd(),
      provider: "test-provider",
      scheduler,
    };

    expect(shouldAutoRunVerifier({ ...base, planRun: { mode: "goal", status: "completed", completed: true } }).shouldRun).toBe(true);
    expect(shouldAutoRunVerifier({ ...base, planRun: { mode: "autopilot", completed: true } }).shouldRun).toBe(true);

    for (const status of ["failed", "blocked", "needs_user", "aborted", "running"] as const) {
      const decision = shouldAutoRunVerifier({ ...base, planRun: { mode: "goal", status, completed: status === "completed" } });
      expect(decision.shouldRun).toBe(false);
      expect(decision.reason).toBe("non_success_status");
    }
  });

  test("submits a background verification task and returns the task id", async () => {
    const cwd = createPackageFixture();
    const scheduler = new ParallelAgentScheduler({ maxParallelAgentTasks: 1 });

    const result = startAutoVerifier({
      enabled: true,
      cwd,
      provider: "test-provider",
      model: "test-model",
      scheduler,
      planRun: { planRunId: "plan-1", mode: "autopilot", status: "completed", completed: true, goal: "ship" },
      commands: [{ name: "quick", command: "node -e \"process.exit(0)\"", source: "explicit" }],
    });

    expect(result.started).toBe(true);
    expect(result.taskId).toBeTruthy();
    expect(result.commands.map((command) => command.name)).toEqual(["quick"]);

    await scheduler.waitForIdle();
    const task = scheduler.getTask(result.taskId!);
    expect(task?.status).toBe("completed");
    expect(task?.description).toContain("auto-verification:autopilot");
    expect(task?.write).toBe(false);
    expect(task?.finalText).toContain("VERIFICATION_PASSED");

    rmSync(cwd, { recursive: true, force: true });
  });

  test("does not submit when no commands are available", () => {
    const cwd = mkdtempSync(join(tmpdir(), "coreline-auto-verifier-empty-"));
    const scheduler = new ParallelAgentScheduler();

    const result = startAutoVerifier({
      enabled: true,
      cwd,
      provider: "test-provider",
      scheduler,
      planRun: { mode: "plan", status: "completed", completed: true },
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe("no_commands");
    expect(scheduler.snapshot().tasks).toHaveLength(0);
    rmSync(cwd, { recursive: true, force: true });
  });
});
