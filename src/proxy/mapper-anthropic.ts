/**
 * Anthropic Messages API (POST /v1/messages) ↔ internal ChatRequest/ChatChunk mapper.
 *
 * Used by the proxy server to accept requests in Anthropic's native wire format
 * and forward them to any registered LLMProvider, regardless of whether the
 * underlying provider is anthropic, openai, gemini, or a CLI fallback.
 */

import type {
  ChatMessage,
  ContentBlock,
  Usage,
} from "../agent/types.js";
import type { ChatChunk, ChatRequest, ToolDefinition } from "../providers/types.js";
import { createHostedToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Anthropic wire types (subset of what we need)
// ---------------------------------------------------------------------------

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
  thinking?: string;
  is_error?: boolean;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicFunctionTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicHostedTool {
  type: "web_search_20250305" | "code_execution_20250825" | (string & {});
  name: string;
  [key: string]: unknown;
}

export type AnthropicTool = AnthropicFunctionTool | AnthropicHostedTool;

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  tools?: AnthropicTool[];
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Request: Anthropic → internal ChatRequest
// ---------------------------------------------------------------------------

export function toChatRequest(
  body: AnthropicMessagesRequest,
  signal?: AbortSignal,
): ChatRequest {
  const messages = body.messages.map(convertAnthropicMessage);
  const systemPrompt = extractSystemPrompt(body.system);
  const tools = body.tools?.map(convertAnthropicTool);

  return {
    messages,
    systemPrompt,
    tools,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    signal,
  };
}

function extractSystemPrompt(
  system: string | AnthropicContentBlock[] | undefined,
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function convertAnthropicMessage(msg: AnthropicMessage): ChatMessage {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return { role: "user", content: msg.content };
    }
    return {
      role: "user",
      content: msg.content.map(convertAnthropicBlock),
    };
  }
  // assistant
  const blocks =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content } as AnthropicContentBlock]
      : msg.content;
  return {
    role: "assistant",
    content: blocks.map(convertAnthropicBlock),
  };
}

function convertAnthropicBlock(block: AnthropicContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "image":
      return {
        type: "image",
        mediaType: block.source?.media_type ?? "image/png",
        base64: block.source?.data ?? "",
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id ?? "",
        name: block.name ?? "",
        input: block.input ?? {},
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.tool_use_id ?? "",
        content: flattenToolResultContent(block.content),
        isError: block.is_error,
      };
    default:
      return { type: "text", text: block.text ?? "" };
  }
}

function flattenToolResultContent(
  content: string | AnthropicContentBlock[] | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function isAnthropicFunctionTool(tool: AnthropicTool): tool is AnthropicFunctionTool {
  return !("type" in tool);
}

function convertAnthropicTool(tool: AnthropicTool): ToolDefinition {
  if (isAnthropicFunctionTool(tool)) {
    return {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.input_schema,
    };
  }

  const hosted = tool as AnthropicHostedTool;
  const { type, name, ...config } = hosted;
  return createHostedToolDefinition(
    String(name),
    String(type),
    config as Record<string, unknown>,
  );
}

// ---------------------------------------------------------------------------
// Response: internal ChatChunks → Anthropic
// ---------------------------------------------------------------------------

function generateMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function isHostedToolName(name: string): boolean {
  return name === "web_search" || name === "code_execution";
}

function toAnthropicToolBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AnthropicContentBlock {
  if (isHostedToolName(name)) {
    return {
      type: "server_tool_use",
      id,
      name,
      input,
    };
  }

  return {
    type: "tool_use",
    id,
    name,
    input,
  };
}

/**
 * Non-streaming: consume the full ChatChunk stream and return a single
 * Anthropic Messages API response object.
 */
export async function buildNonStreamingResponse(
  model: string,
  stream: AsyncIterable<ChatChunk>,
): Promise<Record<string, unknown>> {
  const content: AnthropicContentBlock[] = [];
  let currentText = "";
  const toolCalls = new Map<
    string,
    { name: string; args: string }
  >();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta":
        currentText += chunk.text;
        break;
      case "reasoning_delta":
        // Anthropic wire thinking blocks are complex; skip in non-streaming
        // for now to keep the contract simple.
        break;
      case "tool_call_start":
        toolCalls.set(chunk.toolCall.id, {
          name: chunk.toolCall.name,
          args: "",
        });
        break;
      case "tool_call_delta": {
        const active = toolCalls.get(chunk.toolCallId);
        if (active) active.args += chunk.inputDelta;
        break;
      }
      case "tool_call_end":
        break;
      case "done":
        usage = chunk.usage;
        stopReason = chunk.stopReason;
        break;
    }
  }

  if (currentText) {
    content.push({ type: "text", text: currentText });
  }
  for (const [id, tc] of toolCalls) {
    let parsedInput: Record<string, unknown> = {};
    try {
      parsedInput = tc.args ? JSON.parse(tc.args) : {};
    } catch {
      parsedInput = { _raw: tc.args };
    }
    content.push(toAnthropicToolBlock(id, tc.name, parsedInput));
  }

  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Streaming: convert ChatChunks → Anthropic SSE events (message_start,
 * content_block_start/delta/stop, message_delta, message_stop).
 */
export async function *toAnthropicSseEvents(
  model: string,
  stream: AsyncIterable<ChatChunk>,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const msgId = generateMessageId();
  let textBlockIndex: number | null = null;
  let blockCounter = 0;
  const toolBlockIndex = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta": {
        if (textBlockIndex === null) {
          textBlockIndex = blockCounter++;
          yield {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: textBlockIndex,
              content_block: { type: "text", text: "" },
            },
          };
        }
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: chunk.text },
          },
        };
        break;
      }
      case "reasoning_delta": {
        // Reasoning is emitted as a dedicated thinking content block when
        // the provider supplies it. Use index 0 group before text.
        // For simplicity, skip streaming thinking for non-native clients.
        break;
      }
      case "tool_call_start": {
        if (textBlockIndex !== null) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: textBlockIndex },
          };
          textBlockIndex = null;
        }
        const idx = blockCounter++;
        toolBlockIndex.set(chunk.toolCall.id, idx);
        yield {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: idx,
            content_block: toAnthropicToolBlock(chunk.toolCall.id, chunk.toolCall.name, {}),
          },
        };
        break;
      }
      case "tool_call_delta": {
        const idx = toolBlockIndex.get(chunk.toolCallId);
        if (idx !== undefined) {
          yield {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: idx,
              delta: {
                type: "input_json_delta",
                partial_json: chunk.inputDelta,
              },
            },
          };
        }
        break;
      }
      case "tool_call_end": {
        const idx = toolBlockIndex.get(chunk.toolCallId);
        if (idx !== undefined) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: idx },
          };
        }
        break;
      }
      case "done": {
        inputTokens = chunk.usage.inputTokens;
        outputTokens = chunk.usage.outputTokens;
        stopReason = chunk.stopReason;
        break;
      }
    }
  }

  if (textBlockIndex !== null) {
    yield {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: textBlockIndex },
    };
  }

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };

  yield {
    event: "message_stop",
    data: { type: "message_stop" },
  };
}
