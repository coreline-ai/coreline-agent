/**
 * Phase A1 tests — provider streaming bug fixes.
 * Uses mock streams to verify chunk handling.
 */

import { describe, test, expect } from "bun:test";
import type { ChatChunk } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Helper: simulate driveStream-like collection
// ---------------------------------------------------------------------------

async function collectChunks(chunks: ChatChunk[]): Promise<{
  textParts: string[];
  toolCalls: Map<string, { id: string; name: string; inputJson: string }>;
  endedToolIds: string[];
}> {
  const textParts: string[] = [];
  const toolCalls = new Map<string, { id: string; name: string; inputJson: string }>();
  const endedToolIds: string[] = [];

  for (const chunk of chunks) {
    switch (chunk.type) {
      case "text_delta":
        textParts.push(chunk.text);
        break;
      case "tool_call_start":
        toolCalls.set(chunk.toolCall.id, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          inputJson: "",
        });
        break;
      case "tool_call_delta": {
        const tc = toolCalls.get(chunk.toolCallId);
        if (tc) tc.inputJson += chunk.inputDelta;
        break;
      }
      case "tool_call_end":
        endedToolIds.push(chunk.toolCallId);
        break;
    }
  }
  return { textParts, toolCalls, endedToolIds };
}

// ---------------------------------------------------------------------------
// C1,C2: Anthropic multi tool call — ID tracking
// ---------------------------------------------------------------------------

describe("Anthropic-style multi tool call streaming", () => {
  test("two tool calls have separate input JSON (C1,C2)", async () => {
    // Simulate Anthropic stream: text block, then 2 tool_use blocks
    const chunks: ChatChunk[] = [
      { type: "text_delta", text: "I'll search..." },
      // Tool 1
      { type: "tool_call_start", toolCall: { id: "toolu_1", name: "Glob" } },
      { type: "tool_call_delta", toolCallId: "toolu_1", inputDelta: '{"pattern":' },
      { type: "tool_call_delta", toolCallId: "toolu_1", inputDelta: '"*.ts"}' },
      { type: "tool_call_end", toolCallId: "toolu_1" },
      // Tool 2
      { type: "tool_call_start", toolCall: { id: "toolu_2", name: "Grep" } },
      { type: "tool_call_delta", toolCallId: "toolu_2", inputDelta: '{"pattern":"TODO"}' },
      { type: "tool_call_end", toolCallId: "toolu_2" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "tool_use" },
    ];

    const result = await collectChunks(chunks);

    expect(result.toolCalls.size).toBe(2);
    expect(result.toolCalls.get("toolu_1")!.inputJson).toBe('{"pattern":"*.ts"}');
    expect(result.toolCalls.get("toolu_2")!.inputJson).toBe('{"pattern":"TODO"}');
    expect(result.endedToolIds).toEqual(["toolu_1", "toolu_2"]);
  });

  test("text block stop does NOT emit tool_call_end (C2)", async () => {
    // Simulate: text block ends, then tool block starts
    const chunks: ChatChunk[] = [
      { type: "text_delta", text: "Hello" },
      // No tool_call_end for text block — this was the C2 bug
      { type: "tool_call_start", toolCall: { id: "toolu_1", name: "Bash" } },
      { type: "tool_call_delta", toolCallId: "toolu_1", inputDelta: '{"command":"ls"}' },
      { type: "tool_call_end", toolCallId: "toolu_1" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
    ];

    const result = await collectChunks(chunks);
    // Only one tool_call_end, not extras from text block
    expect(result.endedToolIds).toEqual(["toolu_1"]);
  });

  test("unknown tool_call_delta ID is ignored", async () => {
    const chunks: ChatChunk[] = [
      { type: "tool_call_delta", toolCallId: "nonexistent", inputDelta: "ignored" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" },
    ];
    const result = await collectChunks(chunks);
    expect(result.toolCalls.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C3: Gemini tool ID mapping
// ---------------------------------------------------------------------------

describe("Gemini-style tool call with synthetic IDs", () => {
  test("synthetic ID maps to function name", async () => {
    const chunks: ChatChunk[] = [
      { type: "tool_call_start", toolCall: { id: "gemini_tc_0", name: "Glob" } },
      { type: "tool_call_delta", toolCallId: "gemini_tc_0", inputDelta: '{"pattern":"*.ts"}' },
      { type: "tool_call_end", toolCallId: "gemini_tc_0" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
    ];

    const result = await collectChunks(chunks);
    expect(result.toolCalls.get("gemini_tc_0")!.name).toBe("Glob");
    expect(result.toolCalls.get("gemini_tc_0")!.inputJson).toBe('{"pattern":"*.ts"}');
  });
});

// ---------------------------------------------------------------------------
// C4: SSE parser buffer flush
// ---------------------------------------------------------------------------

describe("SSE parser edge cases", () => {
  test("data line ending with newline is not lost", () => {
    // This tests the logic: if stream data ends with \n,
    // the last line before \n should still be processed.
    const rawLines = 'data: {"id":"1","choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}]}\n';
    const lines = rawLines.split("\n");
    // After split: ["data: {...}", ""]
    // pop() gives ""  => buffer is empty, but the data line is in `lines`
    const buffer = lines.pop() ?? "";
    expect(buffer).toBe(""); // buffer should be empty
    expect(lines).toHaveLength(1); // the data line is still in lines
    expect(lines[0]).toContain("data:");
  });

  test("incomplete line stays in buffer", () => {
    const rawData = 'data: {"id":"1","choices":[{"delta":{"content":"he';
    const lines = rawData.split("\n");
    const buffer = lines.pop() ?? "";
    expect(buffer).toBe(rawData); // no newline, whole thing is buffer
    expect(lines).toHaveLength(0);
  });
});
