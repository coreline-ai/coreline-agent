import { describe, expect, test } from "bun:test";
import {
  buildNonStreamingResponse,
  toChatRequest,
} from "../src/proxy/mapper-openai-responses.js";
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

describe("proxy openai responses mapper", () => {
  test("converts responses input items into internal chat request", () => {
    const request = toChatRequest({
      model: "gpt-4.1",
      instructions: "Keep it short.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "Search",
          arguments: "{\"query\":\"README\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "README contents",
        },
      ],
      tools: [
        {
          type: "function",
          name: "Search",
          description: "search files",
          parameters: { type: "object" },
        },
      ],
      max_output_tokens: 512,
      temperature: 0.1,
    });

    expect(request.systemPrompt).toBe("Keep it short.");
    expect(request.maxTokens).toBe(512);
    expect(request.temperature).toBe(0.1);
    expect(request.tools).toEqual([
      {
        name: "Search",
        description: "search files",
        inputSchema: { type: "object" },
      },
    ]);
    expect(request.messages).toEqual([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Search",
            input: { query: "README" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_1",
            content: "README contents",
          },
        ],
      },
    ]);
  });

  test("buildNonStreamingResponse emits response items for text and function calls", async () => {
    const response = await buildNonStreamingResponse(
      "gpt-4.1",
      toStream([
        { type: "text_delta", text: "Hello" },
        {
          type: "tool_call_start",
          toolCall: { id: "call_1", name: "Search" },
        },
        {
          type: "tool_call_delta",
          toolCallId: "call_1",
          inputDelta: "{\"query\":\"README\"}",
        },
        { type: "tool_call_end", toolCallId: "call_1" },
        {
          type: "done",
          usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
          stopReason: "tool_use",
        },
      ]),
    );

    expect(response).toMatchObject({
      object: "response",
      model: "gpt-4.1",
      status: "completed",
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
    });
    const output = (response as { output: Array<Record<string, unknown>> }).output;
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello" }],
    });
    expect(output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "Search",
      arguments: "{\"query\":\"README\"}",
    });
    expect(typeof output[0]?.id).toBe("string");
    expect(typeof output[1]?.id).toBe("string");
  });
});
