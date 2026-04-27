/**
 * OpenAI Responses API (POST /v1/responses) ↔ internal ChatRequest/ChatChunk
 * mapper. This is the API surface Codex CLI uses.
 *
 * Responses API differs from Chat Completions in the input shape:
 * - `instructions` instead of system message
 * - `input` is a typed list of message / function_call / function_call_output
 *   items instead of messages[] with role
 */

import type {
  ChatMessage,
  ContentBlock,
  Usage,
} from "../agent/types.js";
import type { ChatChunk, ChatRequest, ToolDefinition } from "../providers/types.js";
import { createHostedToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Wire types (subset of Responses API)
// ---------------------------------------------------------------------------

export interface ResponsesInputItem {
  type: "message" | "function_call" | "function_call_output";
  role?: "user" | "assistant" | "system";
  content?: Array<{
    type: "input_text" | "output_text";
    text: string;
  }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesHostedTool {
  type: string;
  name?: string;
  [key: string]: unknown;
}

function isResponsesFunctionTool(
  tool: ResponsesTool | ResponsesHostedTool,
): tool is ResponsesTool {
  return tool.type === "function" && "parameters" in tool;
}

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: Array<ResponsesTool | ResponsesHostedTool>;
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Request: Responses → internal ChatRequest
// ---------------------------------------------------------------------------

export function toChatRequest(
  body: ResponsesRequest,
  signal?: AbortSignal,
): ChatRequest {
  const messages: ChatMessage[] = [];

  for (const item of body.input) {
    if (item.type === "message") {
      const text = (item.content ?? [])
        .map((c) => c.text ?? "")
        .filter(Boolean)
        .join("\n");
      if (item.role === "assistant") {
        const content: ContentBlock[] = text ? [{ type: "text", text }] : [];
        messages.push({ role: "assistant", content });
      } else if (item.role === "system") {
        // rolled into instructions below
      } else {
        messages.push({ role: "user", content: text });
      }
      continue;
    }

    if (item.type === "function_call") {
      const prev = messages[messages.length - 1];
      const toolUseBlock: ContentBlock = {
        type: "tool_use",
        id: item.call_id ?? "",
        name: item.name ?? "",
        input: safeParseArgs(item.arguments),
      };
      if (prev && prev.role === "assistant") {
        prev.content.push(toolUseBlock);
      } else {
        messages.push({ role: "assistant", content: [toolUseBlock] });
      }
      continue;
    }

    if (item.type === "function_call_output") {
      const resultBlock: ContentBlock = {
        type: "tool_result",
        toolUseId: item.call_id ?? "",
        content: item.output ?? "",
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

  const tools = body.tools?.map(convertResponsesTool);

  return {
    messages,
    systemPrompt: body.instructions,
    tools,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    signal,
  };
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

function convertResponsesTool(tool: ResponsesTool | ResponsesHostedTool): ToolDefinition {
  if (isResponsesFunctionTool(tool)) {
    return {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.parameters,
    };
  }

  const { type, name, ...config } = tool;
  return createHostedToolDefinition(String(name ?? type), String(type), config as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Response: ChatChunks → Responses API
// ---------------------------------------------------------------------------

function generateResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function generateItemId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function buildNonStreamingResponse(
  model: string,
  stream: AsyncIterable<ChatChunk>,
): Promise<Record<string, unknown>> {
  let text = "";
  const toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }> = [];
  const toolIndex = new Map<string, number>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

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
          name: chunk.toolCall.name,
          arguments: "",
        });
        break;
      }
      case "tool_call_delta": {
        const idx = toolIndex.get(chunk.toolCallId);
        if (idx !== undefined) {
          toolCalls[idx]!.arguments += chunk.inputDelta;
        }
        break;
      }
      case "done":
        usage = chunk.usage;
        stopReason = chunk.stopReason;
        break;
    }
  }

  const output: Array<Record<string, unknown>> = [];
  if (text) {
    output.push({
      type: "message",
      id: generateItemId("msg"),
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: generateItemId("fc"),
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    });
  }

  return {
    id: generateResponseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

export async function *toResponsesSseEvents(
  model: string,
  stream: AsyncIterable<ChatChunk>,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const respId = generateResponseId();
  let textItemId: string | null = null;
  let outputIndex = 0;
  const toolItemIds = new Map<string, { itemId: string; index: number }>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

  yield {
    event: "response.created",
    data: {
      type: "response.created",
      response: { id: respId, status: "in_progress", model },
    },
  };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta": {
        if (!textItemId) {
          textItemId = generateItemId("msg");
          yield {
            event: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: {
                type: "message",
                id: textItemId,
                role: "assistant",
                content: [],
              },
            },
          };
        }
        yield {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: textItemId,
            output_index: outputIndex,
            delta: chunk.text,
          },
        };
        break;
      }
      case "tool_call_start": {
        if (textItemId) {
          yield {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: { type: "message", id: textItemId },
            },
          };
          textItemId = null;
          outputIndex++;
        }
        const itemId = generateItemId("fc");
        toolItemIds.set(chunk.toolCall.id, { itemId, index: outputIndex });
        yield {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              call_id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: "",
            },
          },
        };
        break;
      }
      case "tool_call_delta": {
        const entry = toolItemIds.get(chunk.toolCallId);
        if (entry) {
          yield {
            event: "response.function_call_arguments.delta",
            data: {
              type: "response.function_call_arguments.delta",
              item_id: entry.itemId,
              output_index: entry.index,
              delta: chunk.inputDelta,
            },
          };
        }
        break;
      }
      case "tool_call_end": {
        const entry = toolItemIds.get(chunk.toolCallId);
        if (entry) {
          yield {
            event: "response.function_call_arguments.done",
            data: {
              type: "response.function_call_arguments.done",
              item_id: entry.itemId,
              output_index: entry.index,
            },
          };
          yield {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: entry.index,
              item: { type: "function_call", id: entry.itemId },
            },
          };
          outputIndex = Math.max(outputIndex, entry.index + 1);
        }
        break;
      }
      case "done":
        usage = chunk.usage;
        stopReason = chunk.stopReason;
        break;
    }
  }

  if (textItemId) {
    yield {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { type: "message", id: textItemId },
      },
    };
  }

  yield {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: {
        id: respId,
        status: "completed",
        model,
        stop_reason: stopReason,
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
      },
    },
  };
}
