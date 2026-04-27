import { describe, expect, test } from "bun:test";
import { toChatRequest as anthropicToChatRequest } from "../src/proxy/mapper-anthropic.js";
import { toChatRequest as openAiChatToChatRequest } from "../src/proxy/mapper-openai-chat.js";
import { toChatRequest as openAiResponsesToChatRequest } from "../src/proxy/mapper-openai-responses.js";
import { convertTools as convertAnthropicTools } from "../src/providers/anthropic.js";
import { convertTools as convertCodexTools } from "../src/providers/codex-backend.js";
import { convertTools as convertOpenAiTools } from "../src/providers/openai.js";
import { createHostedToolDefinition } from "../src/providers/types.js";

describe("proxy hosted tools passthrough", () => {
  const anthropicWebSearchHosted = createHostedToolDefinition(
    "web_search",
    "web_search_20250305",
    { max_uses: 3 },
  );
  const openAiWebSearchHosted = createHostedToolDefinition(
    "web_search",
    "web_search",
    { external_web_access: false },
  );
  const codeInterpreterHosted = createHostedToolDefinition(
    "code_execution",
    "code_interpreter",
    { container: { type: "auto", memory_limit: "4g" } },
  );

  test("Anthropic mapper preserves hosted tools and regular function tools", () => {
    const request = anthropicToChatRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "lookup_weather",
          description: "Lookup weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
      ],
    });

    expect(request.tools).toEqual([
      {
        name: "lookup_weather",
        description: "Lookup weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
      {
        kind: "hosted",
        name: "web_search",
        toolType: "web_search_20250305",
        config: { max_uses: 3 },
      },
    ]);
  });

  test("OpenAI Chat mapper preserves hosted tools in the internal request", () => {
    const request = openAiChatToChatRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "web_search",
          external_web_access: false,
        },
      ],
    });

    expect(request.tools).toEqual([
      {
        kind: "hosted",
        name: "web_search",
        toolType: "web_search",
        config: { external_web_access: false },
      },
    ]);
  });

  test("OpenAI Responses mapper preserves hosted tools in the internal request", () => {
    const request = openAiResponsesToChatRequest({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [
        {
          type: "web_search",
          external_web_access: false,
        },
        {
          type: "code_interpreter",
          container: { type: "auto", memory_limit: "4g" },
        },
      ],
    });

    expect(request.tools).toEqual([
      {
        kind: "hosted",
        name: "web_search",
        toolType: "web_search",
        config: { external_web_access: false },
      },
      {
        kind: "hosted",
        name: "code_interpreter",
        toolType: "code_interpreter",
        config: { container: { type: "auto", memory_limit: "4g" } },
      },
    ]);
  });

  test("Anthropic provider passes hosted tools through to the wire shape", () => {
    expect(convertAnthropicTools([anthropicWebSearchHosted], "anthropic")).toEqual([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      },
    ]);
  });

  test("Codex backend provider passes hosted tools through to the wire shape", () => {
    expect(convertCodexTools([openAiWebSearchHosted, codeInterpreterHosted], "codex-backend")).toEqual([
      {
        type: "web_search",
        external_web_access: false,
      },
      {
        type: "code_interpreter",
        container: { type: "auto", memory_limit: "4g" },
      },
    ]);
  });

  test("OpenAI chat provider rejects hosted tools with a clear error", () => {
    expect(() => convertOpenAiTools([anthropicWebSearchHosted], "openai")).toThrow(
      /hosted tool "web_search" \(web_search_20250305\) is not supported/,
    );
  });
});
