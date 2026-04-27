import { describe, expect, test } from "bun:test";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import { createAppState } from "../src/agent/context.js";
import { executePlan } from "../src/agent/plan-execute/runner.js";
import type { Plan } from "../src/agent/plan-execute/types.js";
import type { Replanner, ReplanRequest } from "../src/agent/plan-execute/replanner.js";

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

describe("plan-execute replan", () => {
  test("replans a failed task and retries the revised plan", async () => {
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

    const replanRequests: ReplanRequest[] = [];
    const replanner: Replanner = {
      async replan(request) {
        replanRequests.push(request);
        return {
          plan: {
            goal: request.goal,
            tasks: [
              {
                id: "task-1",
                description: "Retry inspection with a narrower scope",
                dependsOn: [],
                status: "pending",
              },
              {
                id: "task-2",
                description: "Summarize findings",
                dependsOn: ["task-1"],
                status: "pending",
              },
            ],
          },
          reason: "retry the failed inspection",
        };
      },
    };

    const calls: string[] = [];
    let firstAttempt = true;
    const result = await executePlan(plan, state, {
      replanner,
      runTask: async (task) => {
        calls.push(task.id);
        if (task.id === "task-1" && firstAttempt) {
          firstAttempt = false;
          return "permission denied";
        }
        return `${task.description} completed successfully`;
      },
    });

    expect(replanRequests).toHaveLength(1);
    expect(replanRequests[0]?.failedTask.id).toBe("task-1");
    expect(replanRequests[0]?.remainingTasks.map((task) => task.id)).toEqual(["task-2"]);
    expect(calls).toEqual(["task-1", "task-1", "task-2"]);
    expect(result.steps).toHaveLength(3);
    expect(result.plan.tasks[0]?.description).toBe("Retry inspection with a narrower scope");
    expect(result.plan.tasks[0]?.status).toBe("verified");
    expect(result.plan.tasks[1]?.status).toBe("verified");
    expect(result.summary.completed).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.completed).toBe(true);
  });

  test("keeps completed prefix tasks and only replans the remaining tail", async () => {
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

    const replanner: Replanner = {
      async replan(request) {
        expect(request.failedTask.id).toBe("task-2");
        return {
          plan: {
            goal: request.goal,
            tasks: [
              {
                id: "task-1",
                description: "Inspect files",
                dependsOn: [],
                status: "pending",
              },
              {
                id: "task-2",
                description: "Retry summary",
                dependsOn: ["task-1"],
                status: "pending",
              },
              {
                id: "task-3",
                description: "Document fixes",
                dependsOn: ["task-2"],
                status: "pending",
              },
            ],
          },
        };
      },
    };

    const calls: string[] = [];
    const result = await executePlan(plan, state, {
      replanner,
      runTask: async (task) => {
        calls.push(task.id);
        if (task.id === "task-2" && calls.filter((id) => id === "task-2").length === 1) {
          return "timeout";
        }
        return `${task.description} completed successfully`;
      },
    });

    expect(calls).toEqual(["task-1", "task-2", "task-2", "task-3"]);
    expect(result.plan.tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
    expect(result.plan.tasks[0]?.status).toBe("verified");
    expect(result.plan.tasks[1]?.status).toBe("verified");
    expect(result.plan.tasks[2]?.status).toBe("verified");
    expect(result.summary.completed).toBe(3);
    expect(result.summary.failed).toBe(0);
  });

  test("exhausts retry budget before consuming replan attempts", async () => {
    const state = createAppState({
      cwd: process.cwd(),
      provider: createProvider(),
      tools: [],
    });

    const plan: Plan = {
      goal: "repair the flaky task",
      tasks: [
        {
          id: "task-1",
          description: "Repair the flaky task",
          dependsOn: [],
          status: "pending",
          recovery: {
            action: "retry",
            retryBudget: 2,
            retryCount: 0,
          },
        },
      ],
    };

    const replanRequests: ReplanRequest[] = [];
    const replanner: Replanner = {
      async replan(request) {
        replanRequests.push(request);
        return {
          plan: {
            goal: request.goal,
            tasks: [
              {
                id: "task-1",
                description: "Fallback repair path",
                dependsOn: [],
                status: "pending",
              },
            ],
          },
        };
      },
    };

    let attempts = 0;
    const result = await executePlan(plan, state, {
      replanner,
      maxReplansPerTask: 1,
      runTask: async () => {
        attempts += 1;
        return attempts < 4 ? "timeout" : "Fallback repair path completed successfully";
      },
    });

    expect(attempts).toBe(4);
    expect(replanRequests).toHaveLength(1);
    expect(replanRequests[0]?.failedTask.recovery?.retryCount).toBe(2);
    expect(result.plan.tasks[0]?.status).toBe("verified");
    expect(result.summary.failed).toBe(0);
    expect(result.completed).toBe(true);
  });
});
