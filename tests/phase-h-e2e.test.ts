/**
 * Phase H — End-to-End integration tests.
 * Tests full flows: permission ask → user → loop, compact, retry integration.
 */

import { describe, test, expect } from "bun:test";
import { agentLoop } from "../src/agent/loop.js";
import { createAppState } from "../src/agent/context.js";
import { compactMessages } from "../src/agent/context-manager.js";
import { estimateTokens } from "../src/utils/token-estimator.js";
import { BashTool } from "../src/tools/bash/bash-tool.js";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import type { AgentEvent, ChatMessage } from "../src/agent/types.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(responses: ChatChunk[][]): LLMProvider {
  let idx = 0;
  return {
    name: "mock", type: "openai-compatible", model: "mock", maxContextTokens: 100_000,
    supportsToolCalling: true, supportsPlanning: false, supportsStreaming: true,
    async *send(_req: ChatRequest): AsyncIterable<ChatChunk> {
      for (const c of responses[idx++] ?? []) yield c;
    },
  };
}

// ---------------------------------------------------------------------------
// E2E: Permission ask flow — user approves
// ---------------------------------------------------------------------------

describe("E2E: permission_ask with user approval", () => {
  test("agent emits permission_ask event, waits for resolve(true), executes tool", async () => {
    const provider = mockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "t1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "t1", inputDelta: '{"command":"some_unknown_cmd_xyz"}' },
        { type: "tool_call_end", toolCallId: "t1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionMode: "default", // triggers ask for unknown commands
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "run something" }],
      systemPrompt: "test",
    });

    const events: AgentEvent[] = [];
    let permissionAsked = false;

    let result = await loop.next();
    while (!result.done) {
      const event = result.value;
      events.push(event);
      if (event.type === "permission_ask") {
        permissionAsked = true;
        expect(event.toolName).toBe("Bash");
        event.resolve(true); // user approves
      }
      result = await loop.next();
    }

    expect(permissionAsked).toBe(true);
    // Tool should have executed (exit 127 because command doesn't exist)
    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(true); // exit 127
  });
});

// ---------------------------------------------------------------------------
// E2E: Permission ask flow — user denies
// ---------------------------------------------------------------------------

describe("E2E: permission_ask with user denial", () => {
  test("user denies, tool does not execute, LLM receives denial message", async () => {
    const provider = mockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "t1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "t1", inputDelta: '{"command":"unknown_foo_bar"}' },
        { type: "tool_call_end", toolCallId: "t1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "OK, skipping." },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionMode: "default",
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "run foo" }],
      systemPrompt: "test",
    });

    const events: AgentEvent[] = [];
    let result = await loop.next();
    while (!result.done) {
      const event = result.value;
      events.push(event);
      if (event.type === "permission_ask") {
        event.resolve(false); // user denies
      }
      result = await loop.next();
    }

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    const te = toolEnds[0] as { result: string; isError: boolean };
    expect(te.isError).toBe(true);
    expect(te.result).toContain("denied permission");
  });
});

// ---------------------------------------------------------------------------
// E2E: /compact reduces message count
// ---------------------------------------------------------------------------

describe("E2E: /compact slash command behavior", () => {
  test("compactMessages reduces message count when over budget", () => {
    const longMsgs: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Turn ${i}: ${"x".repeat(200)}`,
    }));

    const result = compactMessages(longMsgs, 100, {
      maxTokens: 1000,
      reservedForResponse: 100,
    });

    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(longMsgs.length);
    // First message should be the summary
    expect(result.messages[0]!.content).toContain("summary");
  });

  test("/compact command returns compact action", () => {
    const result = handleSlashCommand("/compact");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("compact");
  });

  test("no compaction needed when within budget", () => {
    const shortMsgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const result = compactMessages(shortMsgs, 50, {
      maxTokens: 100_000,
      reservedForResponse: 8192,
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// E2E: Full multi-turn conversation with tools and permission
// ---------------------------------------------------------------------------

describe("E2E: full multi-turn flow", () => {
  test("user → LLM → tool → LLM → user completes", async () => {
    const provider = mockProvider([
      // Turn 1: LLM calls a tool
      [
        { type: "tool_call_start", toolCall: { id: "t1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "t1", inputDelta: '{"command":"echo hi"}' },
        { type: "tool_call_end", toolCallId: "t1" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "tool_use" },
      ],
      // Turn 2: LLM responds with text
      [
        { type: "text_delta", text: "Output was: hi" },
        { type: "done", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionMode: "acceptAll",
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "echo hi" }],
      systemPrompt: "test",
    });

    const events: AgentEvent[] = [];
    let result = await loop.next();
    while (!result.done) {
      events.push(result.value);
      result = await loop.next();
    }

    expect(result.value.reason).toBe("completed");

    const toolEvents = events.filter((e) => e.type === "tool_start" || e.type === "tool_end");
    expect(toolEvents).toHaveLength(2);

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBeGreaterThan(0);

    expect(state.totalUsage.inputTokens).toBe(30);
    expect(state.totalUsage.outputTokens).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// E2E: Context compaction integrated into agent loop
// ---------------------------------------------------------------------------

describe("E2E: context management in agent loop", () => {
  test("agent loop handles token budget via context manager", async () => {
    // Small context budget forces compaction
    const provider: LLMProvider = {
      name: "tiny", type: "openai-compatible", model: "tiny", maxContextTokens: 500,
      supportsToolCalling: true, supportsPlanning: false, supportsStreaming: true,
      async *send(): AsyncIterable<ChatChunk> {
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, stopReason: "end_turn" };
      },
    };

    // Pre-load many messages to force compaction
    const bigHistory: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Big message ${i}: ${"a".repeat(100)}`,
    }));

    const state = createAppState({ cwd: process.cwd(), provider, tools: [] });

    const loop = agentLoop({
      state,
      messages: bigHistory,
      systemPrompt: "short",
    });

    let result = await loop.next();
    while (!result.done) result = await loop.next();

    expect(result.value.reason).toBe("completed");
  });
});
