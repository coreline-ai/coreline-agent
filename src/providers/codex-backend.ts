/**
 * Codex Backend Provider — ChatGPT direct backend using OAuth tokens.
 *
 * Uses ~/.codex/auth.json (from Codex CLI) to authenticate with
 * https://chatgpt.com/backend-api/codex/responses.
 *
 * No API key required — uses ChatGPT subscription via OAuth.
 */

import type { ChatMessage, ContentBlock, Usage } from "../agent/types.js";
import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  ProviderQuotaMetadata,
  ProviderRateLimitMetadata,
  ProviderResponseMetadata,
  ProviderRuntimeMetadata,
  ToolDefinition,
} from "./types.js";
import {
  isHostedToolDefinition,
  normalizeModelDisplayName,
  unsupportedHostedToolError,
} from "./types.js";
import { getValidCodexTokens, readCodexConfig } from "./codex-auth.js";

// ---------------------------------------------------------------------------
// Message / Tool Conversion
// ---------------------------------------------------------------------------

interface CodexInputItem {
  type: "message" | "function_call" | "function_call_output";
  role?: "user" | "assistant" | "system";
  content?: Array<{ type: "input_text" | "output_text"; text: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

function convertMessages(messages: ChatMessage[]): CodexInputItem[] {
  const items: CodexInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        items.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else {
        // Separate tool_result blocks from text
        const textBlocks: Array<{ type: "input_text"; text: string }> = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            textBlocks.push({ type: "input_text", text: block.text });
          } else if (block.type === "tool_result") {
            items.push({
              type: "function_call_output",
              call_id: block.toolUseId,
              output: block.content,
            });
          }
        }
        if (textBlocks.length > 0) {
          items.push({ type: "message", role: "user", content: textBlocks });
        }
      }
    } else if (msg.role === "assistant") {
      const textBlocks: Array<{ type: "output_text"; text: string }> = [];
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text") {
          textBlocks.push({ type: "output_text", text: block.text });
        } else if (block.type === "tool_use") {
          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
      if (textBlocks.length > 0) {
        items.push({ type: "message", role: "assistant", content: textBlocks });
      }
    }
  }

  return items;
}

export function convertTools(
  tools: ToolDefinition[],
  providerName = "codex-backend",
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    if (isHostedToolDefinition(t)) {
      switch (t.toolType) {
        case "web_search":
        case "code_interpreter":
          return {
            type: t.toolType,
            ...(t.config ?? {}),
          };
        default:
          throw unsupportedHostedToolError(providerName, t);
      }
    }

    return {
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    };
  });
}

// ---------------------------------------------------------------------------
// SSE Parser
// ---------------------------------------------------------------------------

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<{ event?: string; data: unknown }> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent: string | undefined;
      let currentData = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData += line.slice(6);
        } else if (line === "") {
          if (currentData) {
            try {
              yield { event: currentEvent, data: JSON.parse(currentData) };
            } catch { /* skip malformed */ }
          }
          currentEvent = undefined;
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Safe Metadata Helpers
// ---------------------------------------------------------------------------

const RATE_LIMIT_HEADER_NAMES = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "retry-after",
] as const;

const QUOTA_HEADER_NAMES = [
  "x-quota-limit",
  "x-quota-remaining",
  "x-quota-reset",
  "x-codex-quota-limit",
  "x-codex-quota-remaining",
  "x-codex-quota-reset",
  "x-openai-quota-limit",
  "x-openai-quota-remaining",
  "x-openai-quota-reset",
] as const;

function finitePositiveNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonEmptyHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstHeader(headers: Headers, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = nonEmptyHeader(headers, name);
    if (value) return value;
  }
  return undefined;
}

function collectHeaders(headers: Headers, names: readonly string[]): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = nonEmptyHeader(headers, name);
    if (value) result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function compactObject<T extends object>(value: T): T | undefined {
  const compacted = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function cloneMetadata<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function readCodexResponseMetadata(headers: Headers): ProviderResponseMetadata | undefined {
  const quotaHeaders = collectHeaders(headers, QUOTA_HEADER_NAMES);
  const rateLimitHeaders = collectHeaders(headers, RATE_LIMIT_HEADER_NAMES);

  const quota = compactObject<ProviderQuotaMetadata>({
    limit: finitePositiveNumber(
      firstHeader(headers, ["x-quota-limit", "x-codex-quota-limit", "x-openai-quota-limit"]) ?? null,
    ),
    remaining: finitePositiveNumber(
      firstHeader(headers, ["x-quota-remaining", "x-codex-quota-remaining", "x-openai-quota-remaining"]) ?? null,
    ),
    reset: firstHeader(headers, ["x-quota-reset", "x-codex-quota-reset", "x-openai-quota-reset"]),
    headers: quotaHeaders,
  });

  const rateLimit = compactObject<ProviderRateLimitMetadata>({
    limitRequests: finitePositiveNumber(headers.get("x-ratelimit-limit-requests")),
    remainingRequests: finitePositiveNumber(headers.get("x-ratelimit-remaining-requests")),
    resetRequests: nonEmptyHeader(headers, "x-ratelimit-reset-requests"),
    limitTokens: finitePositiveNumber(headers.get("x-ratelimit-limit-tokens")),
    remainingTokens: finitePositiveNumber(headers.get("x-ratelimit-remaining-tokens")),
    resetTokens: nonEmptyHeader(headers, "x-ratelimit-reset-tokens"),
    retryAfterSeconds: finitePositiveNumber(headers.get("retry-after")),
    headers: rateLimitHeaders,
  });

  if (!quota && !rateLimit) return undefined;

  return {
    capturedAt: new Date().toISOString(),
    ...(quota ? { quota } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

export class CodexBackendProvider implements LLMProvider {
  readonly name: string;
  readonly type = "codex-backend" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = true;
  readonly supportsPlanning = true;
  readonly supportsStreaming = true;
  readonly modelReasoningEffort?: string;

  private baseUrl: string;
  private authFile?: string;
  private runtimeMetadata: ProviderRuntimeMetadata;

  constructor(config: ProviderConfig) {
    const codexConfig = readCodexConfig();
    const configuredModel =
      typeof config.model === "string" && config.model.trim().length > 0
        ? config.model
        : undefined;

    this.name = config.name;
    this.model = configuredModel ?? codexConfig.model ?? "gpt-5"; // e.g. "gpt-5", "gpt-5-codex"
    this.modelReasoningEffort = codexConfig.modelReasoningEffort;
    this.baseUrl = (config.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/$/, "");
    this.authFile = config.oauthFile;
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    this.runtimeMetadata = {
      providerName: this.name,
      providerType: this.type,
      model: this.model,
      modelDisplayName: normalizeModelDisplayName(this.type, this.model),
      modelSource: configuredModel ? "provider-config" : codexConfig.model ? "codex-config" : "default",
      reasoningEffort: this.modelReasoningEffort,
      config: {
        configPath: codexConfig.filePath,
        authPath: this.authFile,
        model: codexConfig.model,
        modelSource: codexConfig.model ? "codex-config" : undefined,
        reasoningEffort: this.modelReasoningEffort,
        reasoningEffortSource: this.modelReasoningEffort ? "codex-config" : undefined,
      },
    };
  }

  get metadata(): ProviderRuntimeMetadata {
    return this.getMetadata();
  }

  getMetadata(): ProviderRuntimeMetadata {
    return cloneMetadata(this.runtimeMetadata);
  }

  private updateMetadata(patch: Partial<ProviderRuntimeMetadata>): void {
    this.runtimeMetadata = {
      ...this.runtimeMetadata,
      ...patch,
      config: {
        ...this.runtimeMetadata.config,
        ...patch.config,
      },
    };
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const tokens = await getValidCodexTokens(this.authFile);
    this.updateMetadata({
      config: { authPath: tokens.filePath },
    });

    const input = convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      input,
      stream: true,
      store: false,
    };

    if (request.systemPrompt) {
      body.instructions = request.systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = convertTools(request.tools, this.name);
      body.tool_choice = "auto";
    }

    if (request.maxTokens) body.max_output_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const response = await fetch(`${this.baseUrl}/codex/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokens.accessToken}`,
        "chatgpt-account-id": tokens.accountId,
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    const responseMetadata = readCodexResponseMetadata(response.headers);
    if (responseMetadata) {
      this.updateMetadata({
        quota: responseMetadata.quota,
        rateLimit: responseMetadata.rateLimit,
        lastResponse: responseMetadata,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      throw new Error(`[${this.name}] Codex API ${response.status}: ${errText}`);
    }
    if (!response.body) {
      throw new Error(`[${this.name}] No response body`);
    }

    const reader = response.body.getReader();
    const activeToolCalls = new Map<string, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn";

    for await (const { event, data } of parseSSE(reader)) {
      const d = data as Record<string, unknown>;

      // Text delta
      if (event === "response.output_text.delta" || d.type === "response.output_text.delta") {
        const delta = (d.delta as string) ?? "";
        if (delta) yield { type: "text_delta", text: delta };
        continue;
      }

      // Reasoning delta (o1/gpt-5 reasoning)
      if (event === "response.reasoning_summary_text.delta" || d.type === "response.reasoning_summary_text.delta") {
        const delta = (d.delta as string) ?? "";
        if (delta) yield { type: "reasoning_delta", text: delta };
        continue;
      }

      // Tool call output_item.added
      if (d.type === "response.output_item.added") {
        const item = d.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === "function_call" && item.name) {
          const id = item.call_id ?? item.id ?? `fc_${Date.now()}`;
          activeToolCalls.set(id, { id, name: item.name, args: "" });
          yield { type: "tool_call_start", toolCall: { id, name: item.name } };
        } else if (item?.type === "web_search_call") {
          const id = item.call_id ?? item.id ?? `ws_${Date.now()}`;
          activeToolCalls.set(id, { id, name: "web_search", args: "" });
          yield { type: "tool_call_start", toolCall: { id, name: "web_search" } };
        } else if (item?.type === "code_interpreter_call") {
          const id = item.call_id ?? item.id ?? `ci_${Date.now()}`;
          activeToolCalls.set(id, { id, name: "code_interpreter", args: "" });
          yield { type: "tool_call_start", toolCall: { id, name: "code_interpreter" } };
        }
        continue;
      }

      // Function call argument delta
      if (d.type === "response.function_call_arguments.delta") {
        const callId = (d.item_id as string) ?? (d.call_id as string) ?? "";
        const delta = (d.delta as string) ?? "";
        // Find by call_id or output_index
        const active = [...activeToolCalls.values()].find((tc) => tc.id === callId);
        if (active && delta) {
          active.args += delta;
          yield { type: "tool_call_delta", toolCallId: active.id, inputDelta: delta };
        }
        continue;
      }

      // Function call complete
      if (d.type === "response.function_call_arguments.done") {
        const callId = (d.item_id as string) ?? "";
        const active = [...activeToolCalls.values()].find((tc) => tc.id === callId);
        if (active) {
          yield { type: "tool_call_end", toolCallId: active.id };
        }
        continue;
      }

      // Final response done
      if (event === "response.completed" || d.type === "response.completed") {
        const resp = d.response as { usage?: Record<string, number>; status?: string } | undefined;
        if (resp?.usage) {
          usage = {
            inputTokens: resp.usage.input_tokens ?? 0,
            outputTokens: resp.usage.output_tokens ?? 0,
            totalTokens: resp.usage.total_tokens ?? 0,
          };
        }
        if (activeToolCalls.size > 0) stopReason = "tool_use";
      }
    }

    yield {
      type: "done",
      usage,
      stopReason,
      ...(responseMetadata ? { metadata: responseMetadata } : {}),
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
}
