import { describe, expect, test } from "bun:test";
import { agentLoop } from "../src/agent/loop.js";
import { createAppState } from "../src/agent/context.js";
import type { AgentEvent } from "../src/agent/types.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";

function createCapturingProvider(): LLMProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    requests,
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(request);
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" };
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent, { reason: string }>) {
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
  return result.value;
}

describe("agentLoop runtime options", () => {
  test("passes temperature to provider request", async () => {
    const provider = createCapturingProvider();
    const state = createAppState({ cwd: process.cwd(), provider, tools: [] });

    await drain(agentLoop({
      state,
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "system",
      temperature: 0.25,
    }));

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.temperature).toBe(0.25);
  });
});
