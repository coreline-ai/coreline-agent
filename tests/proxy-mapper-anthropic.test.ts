import { describe, expect, test } from "bun:test";
import {
  buildNonStreamingResponse,
  toChatRequest,
} from "../src/proxy/mapper-anthropic.js";
import type { ChatChunk } from "../src/providers/types.js";

function toStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe("proxy anthropic mapper", () => {
  test("converts anthropic messages and tools into internal chat request", () => {
    const request = toChatRequest(
      {
        model: "claude-sonnet",
        system: [
          { type: "text", text: "First line" },
          { type: "text", text: "Second line" },
        ],
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "tool_1",
                name: "FileRead",
                input: { file_path: "README.md" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: "README contents",
                is_error: false,
              },
            ],
          },
        ],
        tools: [
          {
            name: "FileRead",
            description: "read a file",
            input_schema: { type: "object" },
          },
        ],
        max_tokens: 128,
        temperature: 0.2,
      },
    );

    expect(request.systemPrompt).toBe("First line\nSecond line");
    expect(request.maxTokens).toBe(128);
    expect(request.temperature).toBe(0.2);
    expect(request.tools).toEqual([
      {
        name: "FileRead",
        description: "read a file",
        inputSchema: { type: "object" },
      },
    ]);
    expect(request.messages).toEqual([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "tool_1",
            name: "FileRead",
            input: { file_path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tool_1",
            content: "README contents",
            isError: false,
          },
        ],
      },
    ]);
  });

  test("buildNonStreamingResponse returns anthropic-style assistant content", async () => {
    const response = await buildNonStreamingResponse(
      "claude-sonnet",
      toStream([
        { type: "text_delta", text: "Hello " },
        {
          type: "tool_call_start",
          toolCall: { id: "tool_1", name: "FileRead" },
        },
        {
          type: "tool_call_delta",
          toolCallId: "tool_1",
          inputDelta: "{\"file_path\":\"README.md\"}",
        },
        { type: "tool_call_end", toolCallId: "tool_1" },
        {
          type: "done",
          usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
          stopReason: "tool_use",
        },
      ]),
    );

    expect(response).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(response).toHaveProperty("content");
    expect((response as { content: Array<Record<string, unknown>> }).content).toEqual([
      { type: "text", text: "Hello " },
      {
        type: "tool_use",
        id: "tool_1",
        name: "FileRead",
        input: { file_path: "README.md" },
      },
    ]);
  });
});
