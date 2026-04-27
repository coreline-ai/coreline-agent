/**
 * Anthropic (Claude) provider adapter.
 *
 * Uses @anthropic-ai/sdk for native message streaming.
 * Converts Anthropic's content_block format ↔ our ChatChunk stream.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ContentBlock, Usage } from "../agent/types.js";
import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  ToolDefinition,
} from "./types.js";
import {
  isHostedToolDefinition,
  unsupportedHostedToolError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Message Conversion
// ---------------------------------------------------------------------------

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;
type AnthropicToolStartBlock = {
  type: "tool_use" | "server_tool_use";
  id: string;
  name: string;
};

function isAnthropicToolStartBlock(block: unknown): block is AnthropicToolStartBlock {
  if (!block || typeof block !== "object") {
    return false;
  }

  const rec = block as Record<string, unknown>;
  return (
    (rec.type === "tool_use" || rec.type === "server_tool_use") &&
    typeof rec.id === "string" &&
    typeof rec.name === "string"
  );
}

function convertContentBlocks(blocks: ContentBlock[]): AnthropicContent[] {
  const result: AnthropicContent[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        result.push({ type: "text", text: block.text });
        break;
      case "image":
        result.push({
          type: "image",
          source: {
            type: "base64",
            media_type: block.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: block.base64,
          },
        });
        break;
      case "tool_use":
        result.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case "tool_result":
        result.push({
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        });
        break;
    }
  }
  return result;
}

function convertMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled via system param

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : convertContentBlocks(msg.content);
      result.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: convertContentBlocks(msg.content),
      });
    }
  }

  return result;
}

export function convertTools(
  tools: ToolDefinition[],
  providerName = "anthropic",
): Anthropic.Tool[] {
  return tools.map((t) => {
    if (isHostedToolDefinition(t)) {
      switch (t.toolType) {
        case "web_search_20250305":
        case "code_execution_20250825":
          return {
            type: t.toolType,
            name: t.name,
            ...(t.config ?? {}),
          } as unknown as Anthropic.Tool;
        default:
          throw unsupportedHostedToolError(providerName, t);
      }
    }

    return {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    } as Anthropic.Tool;
  });
}

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  readonly type = "anthropic" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = true;
  readonly supportsPlanning = true;
  readonly supportsStreaming = true;

  private client: Anthropic;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 200_000;

    // OAuth token (from Claude Code) takes precedence over API key
    // Supports: 1) config.oauthToken, 2) CLAUDE_CODE_OAUTH_TOKEN env
    const oauthToken = config.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;

    if (oauthToken) {
      // OAuth mode: explicitly null out x-api-key and set Authorization via defaultHeaders
      this.client = new Anthropic({
        apiKey: null as unknown as string,
        authToken: oauthToken,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        defaultHeaders: {
          "authorization": `Bearer ${oauthToken}`,
          "x-api-key": null,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
    } else {
      // Standard API key mode
      this.client = new Anthropic({
        apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
    }
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const messages = convertMessages(request.messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: request.maxTokens ?? 8192,
      messages,
      stream: true,
    };

    if (request.systemPrompt) {
      params.system = request.systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = convertTools(request.tools, this.name);
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    const stream = this.client.messages.stream(params, {
      signal: request.signal ?? undefined,
    });

    // Maps content block index → tool use block ID (for delta routing)
    const blockIdByIndex = new Map<number, string>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (isAnthropicToolStartBlock(block)) {
            blockIdByIndex.set(event.index, block.id);
            yield {
              type: "tool_call_start",
              toolCall: { id: block.id, name: block.name },
            };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            const toolId = blockIdByIndex.get(event.index);
            if (toolId) {
              yield {
                type: "tool_call_delta",
                toolCallId: toolId,
                inputDelta: delta.partial_json,
              };
            }
          } else if ((delta as { type: string }).type === "thinking_delta") {
            // Claude extended thinking
            const thinkingText = (delta as { thinking?: string }).thinking ?? "";
            if (thinkingText) {
              yield { type: "reasoning_delta", text: thinkingText };
            }
          }
          break;
        }

        case "content_block_stop": {
          // Only emit tool_call_end if this block was a tool_use
          const toolId = blockIdByIndex.get(event.index);
          if (toolId) {
            yield { type: "tool_call_end", toolCallId: toolId };
          }
          break;
        }

        case "message_stop": {
          blockIdByIndex.clear();
          break;
        }

        case "message_delta": {
          const finalMessage = await stream.finalMessage();
          const stopReason =
            finalMessage.stop_reason === "tool_use"
              ? "tool_use"
              : finalMessage.stop_reason === "max_tokens"
                ? "max_tokens"
                : "end_turn";

          yield {
            type: "done",
            usage: {
              inputTokens: finalMessage.usage.input_tokens,
              outputTokens: finalMessage.usage.output_tokens,
              totalTokens:
                finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
            },
            stopReason,
          };
          break;
        }
      }
    }
  }

  countTokens(text: string): number {
    // Anthropic roughly: 1 token ≈ 3.5 chars for English
    return Math.ceil(text.length / 3.5);
  }
}
