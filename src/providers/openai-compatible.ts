/**
 * OpenAI-compatible provider adapter.
 *
 * Works with: Ollama, LM Studio, vLLM, any OpenAI-compatible endpoint.
 * Uses raw fetch + SSE parsing (no SDK dependency) for maximum compatibility.
 */

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
import { ThinkTagParser } from "./think-tag-parser.js";
import { convertMessagesToOpenAIStyle } from "./openai-message-conversion.js";

// ---------------------------------------------------------------------------
// OpenAI API types (subset)
// ---------------------------------------------------------------------------

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OAIStreamDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OAIStreamChoice {
  index: number;
  delta: OAIStreamDelta;
  finish_reason: string | null;
}

interface OAIStreamChunk {
  id: string;
  choices: OAIStreamChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Message Conversion
// ---------------------------------------------------------------------------

function convertMessages(messages: ChatMessage[]): OAIMessage[] {
  return convertMessagesToOpenAIStyle(messages) as OAIMessage[];
}

export function convertTools(
  tools: ToolDefinition[],
  providerName = "openai-compatible",
): OAITool[] {
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
// SSE Parser
// ---------------------------------------------------------------------------

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<OAIStreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as OAIStreamChunk;
        } catch {
          // skip malformed chunks
        }
      }
    }

    // Flush remaining buffer (handles streams ending with \n)
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6);
        if (data !== "[DONE]") {
          try {
            yield JSON.parse(data) as OAIStreamChunk;
          } catch {
            // skip malformed
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// ReAct Fallback Parser
// ---------------------------------------------------------------------------

/**
 * Parse tool calls from text content.
 * Handles various formats emitted by models that don't use native tool_calls:
 *   1. {"name": "Tool", "arguments": {...}}
 *   2. {"tool": "Tool", "parameters": {...}}
 *   3. ```json\n{...}\n```
 */
function normalizeArgs(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }

  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function parseReactToolCall(
  text: string,
  validToolNames: Set<string>,
): { name: string; args: Record<string, unknown> } | null {
  // Strip markdown code fences (```json and ~~~json styles)
  const cleaned = text
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .replace(/~~~(?:json)?\s*/gi, "")
    .replace(/~~~/g, "")
    .trim();

  // Try parsing as JSON
  const candidates = extractJsonCandidates(cleaned);

  for (const json of candidates) {
    // Normalize single quotes to double quotes (some models misuse quotes)
    const normalized = json.replace(/'/g, '"');
    for (const src of [json, normalized]) {
      try {
        const obj = JSON.parse(src);
        if (typeof obj !== "object" || obj === null) continue;

        const rec = obj as Record<string, unknown>;
        const name = (rec.name ?? rec.tool ?? rec.function ?? rec.function_name ?? rec.tool_name) as
          | string
          | undefined;
        const args = normalizeArgs(rec.arguments ?? rec.parameters ?? rec.args ?? rec.input);

        if (name && validToolNames.has(name) && args) {
          return { name, args };
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/** Extract possible JSON object substrings from text */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly type = "openai-compatible" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling: boolean;
  readonly supportsPlanning: boolean;
  readonly supportsStreaming = true;

  private baseUrl: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey ?? "";
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.supportsToolCalling = true; // assume yes, handle errors gracefully
    this.supportsPlanning = config.planning === true;
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const messages = convertMessages(request.messages);
    if (request.systemPrompt) {
      messages.unshift({ role: "system", content: request.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = convertTools(request.tools, this.name);
    }
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`[${this.name}] API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error(`[${this.name}] No response body`);
    }

    const reader = response.body.getReader();
    const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

    // ReAct fallback: buffer all text in case the model emits tool calls as JSON text
    // (Ollama with Qwen and other models that don't use OpenAI tool_calls field)
    const hasTools = request.tools !== undefined && request.tools.length > 0;
    const toolNames = new Set(request.tools?.map((t) => t.name) ?? []);
    let textBuffer = "";
    let nativeToolCallEmitted = false;

    // <think> tag parser — splits stream into reasoning vs text channels
    const thinkParser = new ThinkTagParser();

    for await (const chunk of parseSSEStream(reader)) {
      // Usage info (often in the final chunk)
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }

      for (const choice of chunk.choices) {
        const delta = choice.delta;

        // Text content — run through <think> tag parser
        if (delta.content) {
          for (const emit of thinkParser.feed(delta.content)) {
            if (emit.type === "reasoning") {
              yield { type: "reasoning_delta", text: emit.text };
            } else {
              textBuffer += emit.text;
              yield { type: "text_delta", text: emit.text };
            }
          }
        }

        // Tool calls (native OpenAI format)
        if (delta.tool_calls) {
          nativeToolCallEmitted = true;
          for (const tc of delta.tool_calls) {
            const idx = tc.index;

            if (tc.id && tc.function?.name) {
              activeToolCalls.set(idx, {
                id: tc.id,
                name: tc.function.name,
                args: tc.function.arguments ?? "",
              });
              yield {
                type: "tool_call_start",
                toolCall: { id: tc.id, name: tc.function.name },
              };
            } else if (tc.function?.arguments) {
              const active = activeToolCalls.get(idx);
              if (active) {
                active.args += tc.function.arguments;
                yield {
                  type: "tool_call_delta",
                  toolCallId: active.id,
                  inputDelta: tc.function.arguments,
                };
              }
            }
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          switch (choice.finish_reason) {
            case "tool_calls":
            case "function_call":
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

    // Flush remaining buffered text from think parser
    for (const emit of thinkParser.flush()) {
      if (emit.type === "reasoning") {
        yield { type: "reasoning_delta", text: emit.text };
      } else {
        textBuffer += emit.text;
        yield { type: "text_delta", text: emit.text };
      }
    }

    // End all active tool calls
    for (const [, tc] of activeToolCalls) {
      yield { type: "tool_call_end", toolCallId: tc.id };
    }

    // ReAct fallback: if no native tool calls but text looks like a tool call, parse it
    if (hasTools && !nativeToolCallEmitted && textBuffer.trim()) {
      const parsed = parseReactToolCall(textBuffer, toolNames);
      if (parsed) {
        const id = `react_${Date.now()}`;
        yield { type: "tool_call_start", toolCall: { id, name: parsed.name } };
        yield { type: "tool_call_delta", toolCallId: id, inputDelta: JSON.stringify(parsed.args) };
        yield { type: "tool_call_end", toolCallId: id };
        stopReason = "tool_use";
      }
    }

    yield { type: "done", usage, stopReason };
  }

  countTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English, ~2 for CJK
    return Math.ceil(text.length / 3.5);
  }
}
