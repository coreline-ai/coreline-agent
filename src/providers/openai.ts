/**
 * OpenAI provider adapter.
 *
 * Uses the official openai SDK. Supports GPT-4o, o1, Codex, etc.
 * For third-party OpenAI-compatible APIs, use openai-compatible.ts instead.
 */

import OpenAI from "openai";
import type { ChatMessage, Usage } from "../agent/types.js";
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
import { convertMessagesToOpenAIStyle } from "./openai-message-conversion.js";

// ---------------------------------------------------------------------------
// Message Conversion
// ---------------------------------------------------------------------------

type OAIMessage = OpenAI.ChatCompletionMessageParam;

function convertMessages(messages: ChatMessage[]): OAIMessage[] {
  return convertMessagesToOpenAIStyle(messages) as OAIMessage[];
}

export function convertTools(
  tools: ToolDefinition[],
  providerName: string,
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => {
    if (isHostedToolDefinition(t)) {
      throw unsupportedHostedToolError(providerName, t);
    }

    return {
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  readonly type = "openai" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = true;
  readonly supportsPlanning = true;
  readonly supportsStreaming = true;

  private client: OpenAI;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;

    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const messages = convertMessages(request.messages);
    if (request.systemPrompt) {
      messages.unshift({ role: "system", content: request.systemPrompt });
    }

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.tools && request.tools.length > 0) {
      params.tools = convertTools(request.tools, this.name);
    }
    if (request.maxTokens) params.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) params.temperature = request.temperature;

    const stream = await this.client.chat.completions.create(params, {
      signal: request.signal ?? undefined,
    });

    const activeToolCalls = new Map<number, { id: string; name: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        };
      }

      for (const choice of chunk.choices) {
        const delta = choice.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id && tc.function?.name) {
              activeToolCalls.set(tc.index, { id: tc.id, name: tc.function.name });
              yield {
                type: "tool_call_start",
                toolCall: { id: tc.id, name: tc.function.name },
              };
            } else if (tc.function?.arguments) {
              const active = activeToolCalls.get(tc.index);
              if (active) {
                yield {
                  type: "tool_call_delta",
                  toolCallId: active.id,
                  inputDelta: tc.function.arguments,
                };
              }
            }
          }
        }

        if (choice.finish_reason) {
          switch (choice.finish_reason) {
            case "tool_calls":
              stopReason = "tool_use";
              break;
            case "length":
              stopReason = "max_tokens";
              break;
            case "stop":
              stopReason = "end_turn";
              break;
          }
        }
      }
    }

    for (const [, tc] of activeToolCalls) {
      yield { type: "tool_call_end", toolCallId: tc.id };
    }

    yield { type: "done", usage, stopReason };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
}
