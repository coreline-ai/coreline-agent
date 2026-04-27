import { describe, expect, test } from "bun:test";
import {
  buildNonStreamingResponse,
  toChatRequest,
} from "../src/proxy/mapper-openai-chat.js";
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

describe("proxy openai chat mapper", () => {
  test("converts system, tool calls, and tool results into internal chat request", () => {
    const request = toChatRequest(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Be brief." },
          {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,QUJD" },
              },
            ],
          },
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "Search",
                  arguments: "{\"query\":\"README\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "README contents",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "Search",
              description: "search files",
              parameters: { type: "object" },
            },
          },
        ],
        max_tokens: 256,
        temperature: 0.3,
      },
    );

    expect(request.systemPrompt).toBe("Be brief.");
    expect(request.maxTokens).toBe(256);
    expect(request.temperature).toBe(0.3);
    expect(request.tools).toEqual([
      {
        name: "Search",
        description: "search files",
        inputSchema: { type: "object" },
      },
    ]);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image", mediaType: "image/png", base64: "QUJD" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
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

  test("buildNonStreamingResponse returns assistant tool_calls payload", async () => {
    const response = await buildNonStreamingResponse(
      "gpt-4o-mini",
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
          usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          stopReason: "tool_use",
        },
      ]),
    );

    expect(response).toMatchObject({
      object: "chat.completion",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Hello",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "Search", arguments: "{\"query\":\"README\"}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
  });
});
