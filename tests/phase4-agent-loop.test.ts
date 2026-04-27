/**
 * Phase 4 tests — agent loop with mock provider.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../src/agent/loop.js";
import { createAppState } from "../src/agent/context.js";
import { BashTool } from "../src/tools/bash/bash-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import { GlobTool } from "../src/tools/glob/glob-tool.js";
import { GrepTool } from "../src/tools/grep/grep-tool.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { buildTool } from "../src/tools/types.js";
import type { AgentEvent, ChatMessage } from "../src/agent/types.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Mock Provider — returns scripted responses
// ---------------------------------------------------------------------------

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
      const chunks = responses[callIndex++] ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

const NoArgTool = buildTool({
  name: "NoArgTool",
  description: "Tool with an empty input schema for fallback testing.",
  inputSchema: z.object({}),
  async call(input: Record<string, unknown>) {
    return { data: input };
  },
  formatResult(output: Record<string, unknown>) {
    return JSON.stringify(output);
  },
});

// Helper to collect all events from the loop
async function collectEvents(
  gen: AsyncGenerator<AgentEvent, { reason: string }>,
): Promise<{ events: AgentEvent[]; returnValue: { reason: string } }> {
  const events: AgentEvent[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }
  return { events, returnValue: result.value };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent Loop — text only (no tool calls)", () => {
  test("yields text deltas and completes", async () => {
    const provider = createMockProvider([
      [
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world!" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    // Should have text deltas + turn_end
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe("Hello ");
    expect((textDeltas[1] as { text: string }).text).toBe("world!");

    const turnEnd = events.find((e) => e.type === "turn_end");
    expect(turnEnd).toBeDefined();
    expect((turnEnd as { reason: string }).reason).toBe("completed");

    expect(returnValue.reason).toBe("completed");
  });
});

describe("Agent Loop — single tool call", () => {
  test("calls tool and returns result to LLM", async () => {
    const provider = createMockProvider([
      // Turn 1: LLM requests a tool call
      [
        { type: "text_delta", text: "Let me check..." },
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "tc_1", inputDelta: '{"command":"echo hello"}' },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, stopReason: "tool_use" },
      ],
      // Turn 2: LLM responds after seeing tool result
      [
        { type: "text_delta", text: "The output is: hello" },
        { type: "done", usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 }, stopReason: "end_turn" },
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
      messages: [{ role: "user", content: "run echo hello" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    // Should have: text_delta, tool_start, tool_end, text_delta, turn_end
    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as { toolName: string }).toolName).toBe("Bash");

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { result: string }).result).toContain("hello");
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(false);

    expect(returnValue.reason).toBe("completed");

    // Usage should be accumulated
    expect(state.totalUsage.inputTokens).toBe(50); // 20 + 30
    expect(state.totalUsage.outputTokens).toBe(25); // 10 + 15
  });

  test("emits persisted assistant/tool-result messages via onMessage", async () => {
    const provider = createMockProvider([
      [
        { type: "text_delta", text: "Let me check..." },
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "tc_1", inputDelta: '{"command":"echo hello"}' },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "The output is: hello" },
        { type: "done", usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionMode: "acceptAll",
    });

    const persistedMessages: ChatMessage[] = [];
    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "run echo hello" }],
      systemPrompt: "You are helpful.",
      onMessage: (message) => persistedMessages.push(message),
    });

    await collectEvents(loop);

    expect(persistedMessages).toHaveLength(3);
    expect(persistedMessages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check..." },
        { type: "tool_use", id: "tc_1", name: "Bash", input: { command: "echo hello" } },
      ],
    });
    expect(persistedMessages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "tc_1", content: "hello", isError: undefined },
      ],
    });
    expect(persistedMessages[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "The output is: hello" }],
    });
  });
});

describe("Agent Loop — permission denied", () => {
  test("denied tool returns error to LLM", async () => {
    const provider = createMockProvider([
      // Turn 1: LLM tries rm -rf
      [
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "tc_1", inputDelta: '{"command":"rm -rf /"}' },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "tool_use" },
      ],
      // Turn 2: LLM apologizes
      [
        { type: "text_delta", text: "Sorry, that was denied." },
        { type: "done", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionRules: [{ behavior: "deny", toolName: "Bash", pattern: "rm *" }],
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "delete everything" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(true);
    expect((toolEnds[0] as { result: string }).result).toContain("Permission denied");

    expect(returnValue.reason).toBe("completed");
  });
});

describe("Agent Loop — max turns", () => {
  test("stops after maxTurns", async () => {
    // Provider always requests a tool call → infinite loop
    const provider = createMockProvider(
      Array(5).fill([
        { type: "tool_call_start", toolCall: { id: "tc_x", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "tc_x", inputDelta: '{"command":"echo loop"}' },
        { type: "tool_call_end", toolCallId: "tc_x" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ]),
    );

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionMode: "acceptAll",
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "loop forever" }],
      systemPrompt: "You are helpful.",
      maxTurns: 3,
    });

    const { events, returnValue } = await collectEvents(loop);

    expect(returnValue.reason).toBe("max_turns");
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect((turnEnds[0] as { reason: string }).reason).toBe("max_turns");
  });
});

describe("Agent Loop — abort", () => {
  test("aborts cleanly on signal", async () => {
    const provider = createMockProvider([
      [
        { type: "text_delta", text: "Starting..." },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    // Abort before starting
    state.abortController.abort();

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "You are helpful.",
    });

    const { returnValue } = await collectEvents(loop);
    expect(returnValue.reason).toBe("aborted");
  });
});

describe("Agent Loop — non-interactive permission handling", () => {
  test("auto-denies ask-required tools in nonInteractive child-like state", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "FileWrite" } },
        {
          type: "tool_call_delta",
          toolCallId: "tc_1",
          inputDelta: '{"file_path":"child-output.txt","content":"hello"}',
        },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [FileWriteTool],
      nonInteractive: true,
      agentDepth: 1,
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "write a file" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    expect(events.find((event) => event.type === "permission_ask")).toBeUndefined();

    const toolEnds = events.filter((event) => event.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(true);
    expect((toolEnds[0] as { result: string }).result).toContain("non-interactive mode");

    expect(returnValue.reason).toBe("completed");
  });
});

describe("Agent Loop — unknown tool", () => {
  test("handles unknown tool gracefully", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "NonExistentTool" } },
        { type: "tool_call_delta", toolCallId: "tc_1", inputDelta: '{}' },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Oops, that tool doesn't exist." },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
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
      messages: [{ role: "user", content: "use nonexistent tool" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { result: string }).result).toContain("Unknown tool");
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(true);

    expect(returnValue.reason).toBe("completed");
  });
});

describe("Agent Loop — malformed and empty tool input JSON", () => {
  test("yields structured error event and falls back to empty input on malformed JSON", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "NoArgTool" } },
        { type: "tool_call_delta", toolCallId: "tc_1", inputDelta: '{"broken":' },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Recovered." },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [NoArgTool],
      permissionMode: "acceptAll",
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "test malformed json" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { error: Error }).error.message).toContain("Malformed tool input JSON");
    expect((errorEvent as { error: Error }).error.message).toContain("falling back to {}");

    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as { input: Record<string, unknown> }).input).toEqual({});

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { result: string }).result).toBe("{}");

    expect(returnValue.reason).toBe("completed");
  });

  test("falls back to empty object when tool input JSON is empty", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "tc_1", name: "NoArgTool" } },
        { type: "tool_call_end", toolCallId: "tc_1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [NoArgTool],
      permissionMode: "acceptAll",
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "test empty json" }],
      systemPrompt: "You are helpful.",
    });

    const { events, returnValue } = await collectEvents(loop);

    expect(events.find((e) => e.type === "error")).toBeUndefined();

    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as { input: Record<string, unknown> }).input).toEqual({});

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { result: string }).result).toBe("{}");

    expect(returnValue.reason).toBe("completed");
  });
});

describe("Agent Loop — API error recovery", () => {
  test("yields error event on provider failure", async () => {
    const provider: LLMProvider = {
      name: "broken",
      type: "openai-compatible",
      model: "broken",
      maxContextTokens: 100_000,
      supportsToolCalling: true,
      supportsPlanning: false,
      supportsStreaming: true,
      async *send(): AsyncIterable<ChatChunk> {
        throw new Error("Network failure");
      },
    };

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "test",
    });

    const { events, returnValue } = await collectEvents(loop);

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(((errors[0] as { error: Error }).error).message).toBe("Network failure");

    expect(returnValue.reason).toBe("error");
  });
});

describe("Agent Loop — duplicate tool call detection", () => {
  test("warns on the 3rd identical call and blocks execution from the 4th", async () => {
    const repeatedToolTurn: ChatChunk[] = [
      { type: "tool_call_start", toolCall: { id: "tc_loop", name: "Bash" } },
      { type: "tool_call_delta", toolCallId: "tc_loop", inputDelta: '{"command":"echo loop"}' },
      { type: "tool_call_end", toolCallId: "tc_loop" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
    ];

    const provider = createMockProvider([
      repeatedToolTurn,
      repeatedToolTurn,
      repeatedToolTurn,
      repeatedToolTurn,
      repeatedToolTurn,
    ]);

    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [BashTool],
      permissionMode: "acceptAll",
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "keep trying echo loop" }],
      systemPrompt: "You are helpful.",
      maxTurns: 5,
    });

    const { events, returnValue } = await collectEvents(loop);

    const loopDetected = events.filter((event) => event.type === "loop_detected");
    expect(loopDetected).toHaveLength(3);
    expect((loopDetected[0] as { consecutiveCount: number }).consecutiveCount).toBe(3);
    expect((loopDetected[1] as { consecutiveCount: number }).consecutiveCount).toBe(4);
    expect((loopDetected[2] as { consecutiveCount: number }).consecutiveCount).toBe(5);

    const toolEnds = events.filter((event) => event.type === "tool_end");
    expect(toolEnds).toHaveLength(5);
    expect((toolEnds[2] as { isError: boolean }).isError).toBe(false);
    expect((toolEnds[3] as { isError: boolean }).isError).toBe(true);
    expect((toolEnds[4] as { isError: boolean }).isError).toBe(true);
    expect((toolEnds[3] as { result: string }).result).toContain("already tried this exact tool call 3 times");

    expect(returnValue.reason).toBe("max_turns");
  });
});

describe("Agent Loop — repeating short tool cycles", () => {
  test("blocks a repeated Glob -> Grep -> FileRead loop without affecting the first pass", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "coreline-loop-"));
    try {
      writeFileSync(join(tempDir, "notes.txt"), "needle\nmore content\n");

      const toolTurn = (toolCallId: string, name: string, inputDelta: string): ChatChunk[] => [
        { type: "tool_call_start", toolCall: { id: toolCallId, name } },
        { type: "tool_call_delta", toolCallId, inputDelta },
        { type: "tool_call_end", toolCallId },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ];

      const provider = createMockProvider([
        toolTurn("tc_1", "Glob", '{"pattern":"**/*.txt"}'),
        toolTurn("tc_2", "Grep", '{"pattern":"needle","path":".","glob":"**/*.txt","output_mode":"files_with_matches"}'),
        toolTurn("tc_3", "FileRead", '{"file_path":"notes.txt"}'),
        toolTurn("tc_4", "Glob", '{"pattern":"**/*.txt"}'),
        toolTurn("tc_5", "Grep", '{"pattern":"needle","path":".","glob":"**/*.txt","output_mode":"files_with_matches"}'),
        toolTurn("tc_6", "FileRead", '{"file_path":"notes.txt"}'),
        [
          { type: "text_delta", text: "stopped after pattern detection" },
          { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
        ],
      ]);

      const state = createAppState({
        cwd: tempDir,
        provider,
        tools: [GlobTool, GrepTool, FileReadTool],
        permissionMode: "acceptAll",
      });

      const loop = agentLoop({
        state,
        messages: [{ role: "user", content: "inspect the files" }],
        systemPrompt: "You are helpful.",
        maxTurns: 10,
      });

      const { events, returnValue } = await collectEvents(loop);

      const loopDetected = events.filter((event) => event.type === "loop_detected");
      expect(loopDetected).toHaveLength(1);
      expect((loopDetected[0] as { message: string }).message).toContain("repeating tool pattern");
      expect((loopDetected[0] as { consecutiveCount: number }).consecutiveCount).toBe(2);

      const toolEnds = events.filter((event) => event.type === "tool_end");
      expect(toolEnds).toHaveLength(6);
      expect((toolEnds[0] as { isError: boolean }).isError).toBe(false);
      expect((toolEnds[1] as { isError: boolean }).isError).toBe(false);
      expect((toolEnds[2] as { isError: boolean }).isError).toBe(false);
      expect((toolEnds[5] as { isError: boolean }).isError).toBe(true);
      expect((toolEnds[5] as { result: string }).result).toContain("repeating tool pattern");

      expect(returnValue.reason).toBe("completed");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
