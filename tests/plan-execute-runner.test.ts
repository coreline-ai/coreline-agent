import { describe, expect, test } from "bun:test";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import { createAppState } from "../src/agent/context.js";
import { executePlan } from "../src/agent/plan-execute/runner.js";
import type { Plan } from "../src/agent/plan-execute/types.js";

function createProvider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

describe("plan-execute runner", () => {
  test("runs tasks in dependency order and aggregates results", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "review src and report back",
      tasks: [
        { id: "task-1", description: "Inspect files", dependsOn: [], status: "pending" },
        { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const calls: string[] = [];
    const taskEvents: string[] = [];
    const result = await executePlan(plan, state, {
      runTask: async (task) => {
        calls.push(task.id);
        return `${task.description} completed`;
      },
      onTaskStart: (task) => {
        taskEvents.push(`start:${task.id}`);
      },
      onTaskEnd: (step) => {
        taskEvents.push(`end:${step.task.id}:${step.task.status}`);
      },
    });

    expect(calls).toEqual(["task-1", "task-2"]);
    expect(taskEvents).toEqual([
      "start:task-1",
      "end:task-1:verified",
      "start:task-2",
      "end:task-2:verified",
    ]);
    expect(result.plan.tasks[0]?.status).toBe("verified");
    expect(result.plan.tasks[1]?.status).toBe("verified");
    expect(result.steps[0]?.task.verification?.status).toBe("passed");
    expect(result.steps[0]?.task.recovery?.action).toBe("stop");
    expect(result.steps[1]?.task.verification?.status).toBe("passed");
    expect(result.steps[1]?.task.recovery?.action).toBe("stop");
    expect(result.summary.completed).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.completed).toBe(true);
  });

  test("skips already completed tasks during resume and backfills verification", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "review src and report back",
      tasks: [
        {
          id: "task-1",
          description: "Inspect files",
          dependsOn: [],
          status: "completed",
          result: { message: "Task completed successfully" },
        },
        { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const calls: string[] = [];
    const result = await executePlan(plan, state, {
      runTask: async (task) => {
        calls.push(task.id);
        return `${task.description} completed`;
      },
    });

    expect(calls).toEqual(["task-2"]);
    expect(result.steps).toHaveLength(1);
    expect(result.plan.tasks[0]?.status).toBe("completed");
    expect(result.plan.tasks[0]?.verification?.status).toBe("passed");
    expect(result.plan.tasks[0]?.recovery?.action).toBe("stop");
    expect(result.plan.tasks[1]?.status).toBe("verified");
    expect(result.completed).toBe(true);
  });

  test("marks dependent tasks as failed when a prerequisite does not complete", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "review src and report back",
      tasks: [
        { id: "task-1", description: "Inspect files", dependsOn: [], status: "pending" },
        { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const calls: string[] = [];
    const result = await executePlan(plan, state, {
      runTask: async (task) => {
        calls.push(task.id);
        if (task.id === "task-1") {
          return "permission denied";
        }
        return "should not run";
      },
    });

    expect(calls).toEqual(["task-1"]);
    expect(result.plan.tasks[0]?.status).toBe("failed");
    expect(result.plan.tasks[1]?.status).toBe("blocked");
    expect(result.steps[0]?.task.verification?.status).toBe("failed");
    expect(result.steps[0]?.task.recovery?.action).toBe("stop");
    expect(result.steps[1]?.evaluation.reason).toContain("dependency task-1 is failed");
    expect(result.summary.failed).toBe(1);
    expect(result.completed).toBe(false);
  });

  test("marks tasks as blocked for external dependency failures", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "review src and report back",
      tasks: [
        { id: "task-1", description: "Fetch upstream state", dependsOn: [], status: "pending" },
        { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const result = await executePlan(plan, state, {
      runTask: async (task) => {
        if (task.id === "task-1") {
          return "service unavailable";
        }
        return "should not run";
      },
    });

    expect(result.plan.tasks[0]?.status).toBe("blocked");
    expect(result.plan.tasks[0]?.recovery?.action).toBe("stop");
    expect(result.plan.tasks[1]?.status).toBe("blocked");
    expect(result.steps[0]?.task.status).toBe("blocked");
    expect(result.steps[1]?.task.status).toBe("blocked");
    expect(result.summary.failed).toBe(0);
    expect(result.completed).toBe(false);
  });

  test("moves to needs_user instead of deadlocking on non-interactive approval requests", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
      nonInteractive: true,
    });

    const plan: Plan = {
      goal: "write a file with approval",
      tasks: [
        { id: "task-1", description: "Write file", dependsOn: [], status: "pending" },
        { id: "task-2", description: "Summarize result", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const calls: string[] = [];
    const result = await executePlan(plan, state, {
      runTask: async (task) => {
        calls.push(task.id);
        return "Permission denied in non-interactive mode for FileWrite";
      },
    });

    expect(calls).toEqual(["task-1"]);
    expect(result.plan.tasks[0]?.status).toBe("needs_user");
    expect(result.plan.tasks[0]?.recovery?.action).toBe("ask-user");
    expect(result.plan.tasks[0]?.nextAction).toBe("ask-user");
    expect(result.plan.tasks[1]?.status).toBe("pending");
    expect(result.steps).toHaveLength(1);
    expect(result.summary.failed).toBe(0);
    expect(result.completed).toBe(false);
  });

  test("retries failed tasks within the configured retry budget before moving on", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "review src and report back",
      tasks: [
        {
          id: "task-1",
          description: "Inspect files",
          dependsOn: [],
          status: "pending",
          recovery: {
            action: "retry",
            retryBudget: 1,
            retryCount: 0,
          },
        },
        { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const calls: string[] = [];
    let firstAttempt = true;
    const result = await executePlan(plan, state, {
      runTask: async (task) => {
        calls.push(task.id);
        if (task.id === "task-1" && firstAttempt) {
          firstAttempt = false;
          return "timeout";
        }
        return `${task.description} completed successfully`;
      },
    });

    expect(calls).toEqual(["task-1", "task-1", "task-2"]);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]?.task.status).toBe("failed");
    expect(result.steps[0]?.task.recovery?.action).toBe("retry");
    expect(result.steps[0]?.task.recovery?.retryCount).toBe(1);
    expect(result.steps[1]?.task.status).toBe("verified");
    expect(result.steps[1]?.task.verification?.status).toBe("passed");
    expect(result.plan.tasks[0]?.status).toBe("verified");
    expect(result.plan.tasks[0]?.verification?.status).toBe("passed");
    expect(result.plan.tasks[0]?.recovery?.action).toBe("stop");
    expect(result.plan.tasks[1]?.status).toBe("verified");
    expect(result.summary.failed).toBe(0);
    expect(result.completed).toBe(true);
  });

  test("passes completed task outputs into downstream execution context", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "run tests and summarize",
      tasks: [
        {
          id: "task-1",
          description: "Run tests",
          dependsOn: [],
          status: "pending",
          verificationHint: {
            contract: "exit_code",
            expectedExitCode: 0,
          },
        },
        { id: "task-2", description: "Summarize findings", dependsOn: ["task-1"], status: "pending" },
      ],
    };

    const contextSnapshots: string[] = [];
    const result = await executePlan(plan, state, {
      runTask: async (task, _context, execution) => {
        if (task.id === "task-2") {
          contextSnapshots.push(execution.completedOutputs.get("task-1")?.summary ?? "");
        }

        return task.id === "task-1"
          ? { exitCode: 0, summary: "Tests passed cleanly." }
          : "Summarized the verified test run.";
      },
    });

    expect(contextSnapshots).toEqual(["Tests passed cleanly."]);
    expect(result.plan.tasks[0]?.status).toBe("completed");
    expect(result.plan.tasks[0]?.output?.summary).toBe("Tests passed cleanly.");
    expect(result.plan.tasks[1]?.status).toBe("verified");
  });
});
