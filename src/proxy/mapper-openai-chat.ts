/**
 * OpenAI Chat Completions API (POST /v1/chat/completions) ↔ internal
 * ChatRequest/ChatChunk mapper.
 */

import type { ChatMessage, ContentBlock, Usage } from "../agent/types.js";
import type { ChatChunk, ChatRequest, ToolDefinition } from "../providers/types.js";
import { createHostedToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// OpenAI wire types (subset)
// ---------------------------------------------------------------------------

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?:
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>
    | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAIChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatHostedTool {
  type: string;
  name?: string;
  [key: string]: unknown;
}

function isOpenAIChatFunctionTool(
  tool: OpenAIChatTool | OpenAIChatHostedTool,
): tool is OpenAIChatTool {
  return tool.type === "function" && "function" in tool;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: Array<OpenAIChatTool | OpenAIChatHostedTool>;
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Request: OpenAI → internal
// ---------------------------------------------------------------------------

export function toChatRequest(
  body: OpenAIChatRequest,
  signal?: AbortSignal,
): ChatRequest {
  let systemPrompt: string | undefined;
  const messages: ChatMessage[] = [];

  // Track pending tool_calls from the most recent assistant message so we can
  // correlate subsequent role=tool messages.
  let lastAssistantToolCalls: Map<string, string> | null = null;

  for (const msg of body.messages) {
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
      }
      continue;
    }

    if (msg.role === "user") {
      const content = flattenUserContent(msg.content);
      messages.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const textContent = extractText(msg.content);
      if (textContent) {
        blocks.push({ type: "text", text: textContent });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        lastAssistantToolCalls = new Map();
        for (const tc of msg.tool_calls) {
          lastAssistantToolCalls.set(tc.id, tc.function.name);
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch {
            parsedInput = { _raw: tc.function.arguments };
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      // OpenAI puts tool results in their own role=tool message; fold them
      // into a user turn as tool_result content blocks so the internal format
      // stays Anthropic-aligned.
      const toolContent = extractText(msg.content);
      const resultBlock: ContentBlock = {
        type: "tool_result",
        toolUseId: msg.tool_call_id ?? "",
        content: toolContent,
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(resultBlock);
      } else {
        messages.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }
  }

  // Unused but kept for future per-id name lookups (e.g. Gemini resolution)
  void lastAssistantToolCalls;

  const tools = body.tools?.map(convertOpenAITool);

  return {
    messages,
    systemPrompt,
    tools,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    signal,
  };
}

function extractText(
  content: OpenAIChatMessage["content"] | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function flattenUserContent(
  content: OpenAIChatMessage["content"] | undefined,
): string | ContentBlock[] {
  if (!content) return "";
  if (typeof content === "string") return content;
  const blocks: ContentBlock[] = [];
  for (const c of content) {
    if (c.type === "text") {
      blocks.push({ type: "text", text: c.text });
    } else if (c.type === "image_url") {
      // Accept data: URIs only; remote URLs are not inlined here.
      const url = c.image_url.url;
      const match = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (match) {
        blocks.push({
          type: "image",
          mediaType: match[1] ?? "image/png",
          base64: match[2] ?? "",
        });
      }
    }
  }
  return blocks.length > 0 ? blocks : "";
}

function convertOpenAITool(tool: OpenAIChatTool | OpenAIChatHostedTool): ToolDefinition {
  if (isOpenAIChatFunctionTool(tool)) {
    return {
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
    };
  }

  const { type, name, ...config } = tool;
  return createHostedToolDefinition(String(name ?? type), String(type), config as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Response: ChatChunks → OpenAI
// ---------------------------------------------------------------------------

function generateCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export async function buildNonStreamingResponse(
  model: string,
  stream: AsyncIterable<ChatChunk>,
): Promise<Record<string, unknown>> {
  let text = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  const toolIndex = new Map<string, number>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finishReason: "stop" | "tool_calls" | "length" = "stop";

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta":
        text += chunk.text;
        break;
      case "tool_call_start": {
        const idx = toolCalls.length;
        toolIndex.set(chunk.toolCall.id, idx);
        toolCalls.push({
          id: chunk.toolCall.id,
          type: "function",
          function: { name: chunk.toolCall.name, arguments: "" },
        });
        break;
      }
      case "tool_call_delta": {
        const idx = toolIndex.get(chunk.toolCallId);
        if (idx !== undefined) {
          toolCalls[idx]!.function.arguments += chunk.inputDelta;
        }
        break;
      }
      case "done":
        usage = chunk.usage;
        finishReason =
          chunk.stopReason === "tool_use"
            ? "tool_calls"
            : chunk.stopReason === "max_tokens"
              ? "length"
              : "stop";
        break;
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: generateCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

export async function *toOpenAiChatSseChunks(
  model: string,
  stream: AsyncIterable<ChatChunk>,
): AsyncGenerator<Record<string, unknown> | "[DONE]"> {
  const id = generateCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const toolIndex = new Map<string, number>();
  let emittedRole = false;
  let finishReason: "stop" | "tool_calls" | "length" = "stop";
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  function baseChunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    };
  }

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta":
        if (!emittedRole) {
          yield baseChunk({ role: "assistant", content: "" });
          emittedRole = true;
        }
        yield baseChunk({ content: chunk.text });
        break;
      case "tool_call_start": {
        if (!emittedRole) {
          yield baseChunk({ role: "assistant", content: null });
          emittedRole = true;
        }
        const idx = toolIndex.size;
        toolIndex.set(chunk.toolCall.id, idx);
        yield baseChunk({
          tool_calls: [
            {
              index: idx,
              id: chunk.toolCall.id,
              type: "function",
              function: { name: chunk.toolCall.name, arguments: "" },
            },
          ],
        });
        break;
      }
      case "tool_call_delta": {
        const idx = toolIndex.get(chunk.toolCallId);
        if (idx !== undefined) {
          yield baseChunk({
            tool_calls: [
              {
                index: idx,
                function: { arguments: chunk.inputDelta },
              },
            ],
          });
        }
        break;
      }
      case "done":
        usage = chunk.usage;
        finishReason =
          chunk.stopReason === "tool_use"
            ? "tool_calls"
            : chunk.stopReason === "max_tokens"
              ? "length"
              : "stop";
        break;
    }
  }

  yield {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
  };
  yield "[DONE]";
}
