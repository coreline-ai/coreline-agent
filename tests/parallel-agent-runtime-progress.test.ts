import { describe, expect, test } from "bun:test";
import { DefaultSubAgentRuntime } from "../src/agent/subagent-runtime.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import type { ToolUseContext } from "../src/tools/types.js";

function createTextProvider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: "text_delta", text: "progress text" };
      yield {
        type: "done",
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        stopReason: "end_turn",
      };
    },
  };
}

function makeContext(overrides?: Partial<ToolUseContext>): ToolUseContext {
  return {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    nonInteractive: true,
    agentDepth: 0,
    permissionContext: { cwd: process.cwd(), mode: "default", rules: [] },
    ...overrides,
  };
}

describe("DefaultSubAgentRuntime parallel progress", () => {
  test("forwards child loop message and usage events to a progress sink", async () => {
    const provider = createTextProvider();
    const runtime = new DefaultSubAgentRuntime({ provider, tools: [] });
    const messages: string[] = [];
    const usageTotals: number[] = [];

    const result = await runtime.run(
      { prompt: "say progress" },
      makeContext({
        parallelAgentProgress: {
          taskId: "parallel-task-0001",
          sink: {
            onMessage(taskId, message) {
              messages.push(`${taskId}:${message}`);
            },
            onUsage(taskId, usage) {
              usageTotals.push((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
              expect(taskId).toBe("parallel-task-0001");
            },
          },
        },
      }),
    );

    expect(result.reason).toBe("completed");
    expect(messages).toEqual(["parallel-task-0001:progress text"]);
    expect(usageTotals).toEqual([8]);
  });
});
