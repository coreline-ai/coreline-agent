import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createAppState } from "../src/agent/context.js";
import { agentLoop } from "../src/agent/loop.js";
import type { AgentEvent } from "../src/agent/types.js";
import { createHookEngine } from "../src/hooks/index.js";
import { buildTool } from "../src/tools/types.js";
import { runToolCalls } from "../src/tools/orchestration.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";

const EchoTool = buildTool({
  name: "Echo",
  description: "Echo a message",
  inputSchema: z.object({ message: z.string() }),
  async call(input) {
    return { data: input.message };
  },
  formatResult(output) {
    return String(output);
  },
  isConcurrencySafe: () => true,
});

const FailingTool = buildTool({
  name: "Failing",
  description: "Fail after receiving a message",
  inputSchema: z.object({ message: z.string() }),
  async call(input) {
    throw new Error(`boom ${input.message}`);
  },
  formatResult(output) {
    return String(output);
  },
  isConcurrencySafe: () => true,
});

function createMockProvider(responses: ChatChunk[][]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      for (const chunk of responses[callIndex++] ?? []) yield chunk;
    },
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent, { reason: string }>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }
  return events;
}

async function collectToolResults(
  contextHookEngine?: ReturnType<typeof createHookEngine>,
  input = { message: "hello" },
  tool = EchoTool,
) {
  const results = [];
  for await (const result of runToolCalls(
    [{ type: "tool_use", id: "tc_1", name: tool.name, input }],
    new Map([[tool.name, tool]]),
    {
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      nonInteractive: false,
      hookEngine: contextHookEngine,
    },
  )) {
    results.push(result);
  }
  return results;
}

describe("PreTool hook permission adapter", () => {
  test("non-blocking PreTool hook allows tool execution", async () => {
    const engine = createHookEngine();
    let called = 0;
    engine.register({ type: "function", event: "PreTool", handler: () => { called += 1; } });

    const results = await collectToolResults(engine);
    expect(called).toBe(1);
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[0]?.formattedResult).toBe("hello");
  });

  test("blocking PreTool hook prevents tool execution", async () => {
    const engine = createHookEngine();
    engine.register({
      id: "blocker",
      name: "blocker",
      type: "function",
      event: "PreTool",
      handler: () => ({ blocking: true, message: "not allowed" }),
    });

    const results = await collectToolResults(engine);
    expect(results[0]?.result.isError).toBe(true);
    expect(results[0]?.formattedResult).toContain("Tool blocked by hook blocker: not allowed");
  });

  test("hook errors fail open", async () => {
    const engine = createHookEngine();
    engine.register({ type: "function", event: "PreTool", handler: () => { throw new Error("hook failed"); } });

    const results = await collectToolResults(engine);
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[0]?.formattedResult).toBe("hello");
  });

  test("missing hook runtime keeps existing tool execution", async () => {
    const results = await collectToolResults(undefined);
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[0]?.formattedResult).toBe("hello");
  });

  test("input schema validation failure skips PreTool hook", async () => {
    const engine = createHookEngine();
    let called = 0;
    engine.register({ type: "function", event: "PreTool", handler: () => { called += 1; } });

    const results = await collectToolResults(engine, { message: 123 as unknown as string });
    expect(called).toBe(0);
    expect(results[0]?.result.isError).toBe(true);
    expect(results[0]?.formattedResult).toContain("Input validation error");
  });

  test("permission deny prevents hook execution in agent loop", async () => {
    const engine = createHookEngine();
    let called = 0;
    engine.register({ type: "function", event: "PreTool", handler: () => { called += 1; } });
    const provider = createMockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "Echo" } },
        { type: "tool_call_delta", toolCallId: "tc_1", inputDelta: '{"message":"hello"}' },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "denied" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" },
      ],
    ]);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [EchoTool],
      hookEngine: engine,
      permissionRules: [{ behavior: "deny", toolName: "Echo", pattern: "*" }],
    });

    const events = await collectEvents(agentLoop({
      state,
      messages: [{ role: "user", content: "echo" }],
      systemPrompt: "test",
    }));

    expect(called).toBe(0);
    const toolEnd = events.find((event) => event.type === "tool_end");
    expect(toolEnd && "isError" in toolEnd ? toolEnd.isError : false).toBe(true);
  });
});

describe("PostTool hook permission adapter", () => {
  test("PostTool hook receives successful tool result after execution", async () => {
    const engine = createHookEngine();
    const seen: unknown[] = [];
    engine.register({
      type: "function",
      event: "PostTool",
      handler: (input) => {
        seen.push(input);
      },
    });

    const results = await collectToolResults(engine);
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[0]?.formattedResult).toBe("hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: "PostTool",
      toolName: "Echo",
      input: { message: "hello" },
      result: "hello",
      isError: false,
      metadata: {
        cwd: process.cwd(),
        nonInteractive: false,
      },
    });
  });

  test("blocking PostTool hook appends a safe message without undoing tool execution", async () => {
    const engine = createHookEngine();
    let called = 0;
    engine.register({
      id: "post-blocker",
      name: "post-blocker",
      type: "function",
      event: "PostTool",
      handler: () => {
        called += 1;
        return { blocking: true, message: "audit flag" };
      },
    });

    const results = await collectToolResults(engine);
    expect(called).toBe(1);
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[0]?.formattedResult).toContain("hello");
    expect(results[0]?.formattedResult).toContain(
      "PostTool hook post-blocker returned blocking after tool execution: audit flag",
    );
  });

  test("PostTool hook runs when tool execution throws", async () => {
    const engine = createHookEngine();
    const seen: unknown[] = [];
    engine.register({
      type: "function",
      event: "PostTool",
      handler: (input) => {
        seen.push(input);
      },
    });

    const results = await collectToolResults(engine, { message: "bad" }, FailingTool);
    expect(results[0]?.result.isError).toBe(true);
    expect(results[0]?.formattedResult).toContain("Tool execution error: boom bad");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: "PostTool",
      toolName: "Failing",
      input: { message: "bad" },
      result: "Tool execution error: boom bad",
      isError: true,
    });
  });

  test("PostTool hook errors fail open", async () => {
    const engine = createHookEngine();
    engine.register({
      type: "function",
      event: "PostTool",
      handler: () => {
        throw new Error("post hook failed");
      },
    });

    const results = await collectToolResults(engine);
    expect(results[0]?.result.isError).toBeUndefined();
    expect(results[0]?.formattedResult).toBe("hello");
  });
});
