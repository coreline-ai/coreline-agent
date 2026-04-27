import { describe, expect, test } from "bun:test";
import { convertMessagesToOpenAIStyle } from "../src/providers/openai-message-conversion.js";
import type { ChatMessage } from "../src/agent/types.js";

describe("convertMessagesToOpenAIStyle", () => {
  test("converts user tool_result blocks into tool messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tc_1", name: "MemoryRead", input: { name: "runtime_pref" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tc_1",
            content: "MEMORY_READ_RESULT\nmode: entry\nENTRY_BODY_START\nUse Bun.\nENTRY_BODY_END",
          },
        ],
      },
    ];

    expect(convertMessagesToOpenAIStyle(messages)).toEqual([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "tc_1",
            type: "function",
            function: { name: "MemoryRead", arguments: "{\"name\":\"runtime_pref\"}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tc_1",
        content: "MEMORY_READ_RESULT\nmode: entry\nENTRY_BODY_START\nUse Bun.\nENTRY_BODY_END",
      },
    ]);
  });

  test("preserves user text around tool results in order", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this." },
          { type: "tool_result", toolUseId: "tc_2", content: "tool output" },
          { type: "text", text: "Be brief." },
        ],
      },
    ];

    expect(convertMessagesToOpenAIStyle(messages)).toEqual([
      { role: "user", content: "Summarize this." },
      { role: "tool", tool_call_id: "tc_2", content: "tool output" },
      { role: "user", content: "Be brief." },
    ]);
  });
});
