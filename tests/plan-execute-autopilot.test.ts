import { describe, expect, test } from "bun:test";
import { createAppState } from "../src/agent/context.js";
import { runAutopilot } from "../src/agent/plan-execute/autopilot.js";
import type { Plan, Planner } from "../src/agent/plan-execute/types.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";

function createProvider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: true,
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

class SequencePlanner implements Planner {
  private index = 0;

  constructor(private readonly plans: Plan[]) {}

  async plan(goal: string): Promise<Plan> {
    const plan = this.plans[Math.min(this.index, this.plans.length - 1)]!;
    this.index += 1;
    return {
      goal,
      tasks: plan.tasks.map((task) => ({
        ...task,
        dependsOn: [...task.dependsOn],
        verificationHint: task.verificationHint ? { ...task.verificationHint } : undefined,
      })),
    };
  }
}

describe("single-agent autopilot", () => {
  test("completes a happy-path goal in one cycle", async () => {
    const state = createAppState({ cwd: process.cwd(), provider: createProvider(), tools: [] });
    const planner = new SequencePlanner([
      {
        goal: "ship fix",
        tasks: [{ id: "task-1", description: "Run verification", dependsOn: [], status: "pending", verificationHint: { contract: "exit_code", expectedExitCode: 0 } }],
      },
    ]);

    const result = await runAutopilot("ship fix", state, {
      planner,
      runTask: async () => ({ exitCode: 0, summary: "Verification passed cleanly." }),
      maxCycles: 3,
    });

    expect(result.stopStatus).toBe("completed");
    expect(result.cycleCount).toBe(1);
    expect(result.result.completed).toBe(true);
    expect(result.decisionLog.some((entry) => entry.kind === "stop")).toBe(true);
  });

  test.each([
    {
      label: "blocked",
      runTask: async () => "service unavailable",
      expectedStopStatus: "blocked" as const,
    },
    {
      label: "needs_user",
      runTask: async () => "Permission denied in non-interactive mode for FileWrite",
      expectedStopStatus: "needs_user" as const,
      nonInteractive: true,
    },
  ])("stops naturally when a goal becomes $label", async ({ runTask, expectedStopStatus, nonInteractive }) => {
    const state = createAppState({ cwd: process.cwd(), provider: createProvider(), tools: [], nonInteractive: Boolean(nonInteractive) });
    const planner = new SequencePlanner([
      { goal: "handle failure", tasks: [{ id: "task-1", description: "Attempt work", dependsOn: [], status: "pending" }] },
    ]);

    const result = await runAutopilot("handle failure", state, {
      planner,
      runTask,
      maxCycles: 3,
    });

    expect(result.stopStatus).toBe(expectedStopStatus);
    expect(result.result.completed).toBe(false);
  });

  test("resumes from an earlier run and records a resume decision", async () => {
    const state = createAppState({ cwd: process.cwd(), provider: createProvider(), tools: [] });
    const planner = new SequencePlanner([
      { goal: "finish goal", tasks: [{ id: "task-2", description: "Finish summary", dependsOn: [], status: "pending", verificationHint: { contract: "exit_code", expectedExitCode: 0 } }] },
    ]);

    const result = await runAutopilot("finish goal", state, {
      planner,
      resumeState: {
        cycleCount: 1,
        plan: { goal: "finish goal", tasks: [{ id: "task-2", description: "Finish summary", dependsOn: [], status: "pending", verificationHint: { contract: "exit_code", expectedExitCode: 0 } }] },
        decisionLog: [{ cycle: 1, kind: "start", reason: "start autopilot from goal input", createdAt: new Date().toISOString() }],
      },
      runTask: async () => ({ exitCode: 0, summary: "Summary passed." }),
      maxCycles: 3,
    });

    expect(result.cycleCount).toBe(2);
    expect(result.stopStatus).toBe("completed");
    expect(result.decisionLog.some((entry) => entry.kind === "resume")).toBe(true);
  });
});
