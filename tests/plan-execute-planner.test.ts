import { describe, expect, test } from "bun:test";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import { createAppState } from "../src/agent/context.js";
import { BasicPlanner } from "../src/agent/plan-execute/planner.js";

function createMockProvider(
  supportsPlanning: boolean,
  chunks: ChatChunk[],
): LLMProvider & { callCount: number; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let callCount = 0;

  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning,
    supportsStreaming: true,
    requests,
    get callCount() {
      return callCount;
    },
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(request);
      callCount += 1;
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe("plan-execute planner", () => {
  test("falls back to a heuristic plan when planning is disabled", async () => {
    const provider = createMockProvider(false, []);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const plan = await new BasicPlanner().plan("review src and run tests", state);

    expect(provider.callCount).toBe(0);
    expect(plan.goal).toBe("review src and run tests");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.description).toBe("review src");
    expect(plan.tasks[1]?.dependsOn).toEqual(["task-1"]);
  });

  test("splits compound fallback goals into verification-friendly steps", async () => {
    const provider = createMockProvider(false, []);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const plan = await new BasicPlanner().plan("review src, run tests, and summarize findings", state);

    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0]?.description).toBe("review src");
    expect(plan.tasks[1]?.description).toBe("run tests");
    expect(plan.tasks[2]?.description).toBe("summarize findings");
    expect(plan.tasks[1]?.verificationHint).toEqual({
      contract: "exit_code",
      expectedExitCode: 0,
    });
    expect(plan.tasks[1]?.dependsOn).toEqual(["task-1"]);
    expect(plan.tasks[2]?.dependsOn).toEqual(["task-2"]);
  });

  test("uses provider-backed planning when JSON is returned", async () => {
    const provider = createMockProvider(true, [
      {
        type: "text_delta",
        text:
          '{"goal":"review src","tasks":[{"id":"task-1","description":"Read src/agent","dependsOn":[]},{"id":"task-2","description":"Summarize findings","dependsOn":["task-1"]}]}',
      },
      {
        type: "done",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      },
    ]);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const plan = await new BasicPlanner().plan("review src", state);

    expect(provider.callCount).toBe(1);
    expect(plan.goal).toBe("review src");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.id).toBe("task-1");
    expect(plan.tasks[0]?.description).toBe("Read src/agent");
    expect(plan.tasks[1]?.dependsOn).toEqual(["task-1"]);
  });

  test("normalizes provider planning output before returning it", async () => {
    const provider = createMockProvider(true, [
      {
        type: "text_delta",
        text:
          "```json\n{\"goal\":\" review src \",\"tasks\":[{\"id\":\" task-1 \",\"description\":\"  inspect src/agent  \",\"dependsOn\":[]},{\"id\":\"task-2\",\"description\":\" run tests.\",\"dependsOn\":\" task-1 \"}]}\n```",
      },
      {
        type: "done",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      },
    ]);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const plan = await new BasicPlanner().plan(" review src ", state);

    expect(provider.callCount).toBe(1);
    expect(plan.goal).toBe("review src");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.id).toBe("task-1");
    expect(plan.tasks[0]?.description).toBe("inspect src/agent");
    expect(plan.tasks[0]?.dependsOn).toEqual([]);
    expect(plan.tasks[1]?.id).toBe("task-2");
    expect(plan.tasks[1]?.description).toBe("run tests");
    expect(plan.tasks[1]?.dependsOn).toEqual(["task-1"]);
    expect(plan.tasks[1]?.verificationHint).toEqual({
      contract: "exit_code",
      expectedExitCode: 0,
    });
  });

  test("preserves explicit verification hints from provider plans", async () => {
    const provider = createMockProvider(true, [
      {
        type: "text_delta",
        text:
          '{"goal":"ship fix","tasks":[{"id":"task-1","description":"Run tests","dependsOn":[],"verificationHint":{"contract":"exit_code","expectedExitCode":0}},{"id":"task-2","description":"Ensure `dist/index.js` exists","dependsOn":["task-1"],"verificationHint":{"contract":"artifact","artifactKind":"file","artifactLabel":"dist/index.js"}}]}',
      },
      {
        type: "done",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      },
    ]);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const plan = await new BasicPlanner().plan("ship fix", state);

    expect(plan.tasks[0]?.verificationHint).toEqual({
      contract: "exit_code",
      expectedExitCode: 0,
      artifactKind: undefined,
      artifactLabel: undefined,
      assertionText: undefined,
      assertionPattern: undefined,
      assertionTarget: undefined,
    });
    expect(plan.tasks[1]?.verificationHint).toEqual({
      contract: "artifact",
      expectedExitCode: undefined,
      artifactKind: "file",
      artifactLabel: "dist/index.js",
      assertionText: undefined,
      assertionPattern: undefined,
      assertionTarget: undefined,
    });
  });
});
