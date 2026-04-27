/**
 * LLM Provider abstraction — the single interface all providers implement.
 *
 * Design: each provider converts its native API format ↔ our ChatChunk stream.
 * OpenAI-compatible providers (Ollama, vLLM, LM Studio) share one adapter.
 * Claude, Gemini get dedicated adapters for format differences.
 */

import type { ChatMessage, Usage } from "../agent/types.js";

// ---------------------------------------------------------------------------
// Tool Definition (sent to LLM as JSON Schema)
// ---------------------------------------------------------------------------

export interface FunctionToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
}

export interface HostedToolDefinition {
  kind: "hosted";
  /** Logical tool name, e.g. web_search or code_execution. */
  name: string;
  /** Wire-level tool type preserved for passthrough. */
  toolType: string;
  /** Provider-specific config fields preserved verbatim. */
  config?: Record<string, unknown>;
}

export type ToolDefinition = FunctionToolDefinition | HostedToolDefinition;

export function isHostedToolDefinition(tool: ToolDefinition): tool is HostedToolDefinition {
  return (tool as HostedToolDefinition).kind === "hosted";
}

export function createHostedToolDefinition(
  name: string,
  toolType: string,
  config: Record<string, unknown> = {},
): HostedToolDefinition {
  return {
    kind: "hosted",
    name,
    toolType,
    config,
  };
}

export function unsupportedHostedToolError(
  providerName: string,
  tool: HostedToolDefinition,
): Error {
  return new Error(
    `[${providerName}] hosted tool "${tool.name}" (${tool.toolType}) is not supported by this provider.`,
  );
}

// ---------------------------------------------------------------------------
// Chat Request (provider-agnostic)
// ---------------------------------------------------------------------------

export interface ChatRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Provider Runtime Metadata (optional observational fields)
// ---------------------------------------------------------------------------

export type ProviderMetadataSource =
  | "provider-config"
  | "codex-config"
  | "response-header"
  | "default"
  | "override"
  | "unknown";

export interface ProviderConfigMetadata {
  /** Path to a provider config file, if one was consulted. Never contains secrets. */
  configPath?: string;
  /** Path to an auth/token file, if one was used. Never contains token values. */
  authPath?: string;
  /** Model value read from provider-specific config, before provider.yml overrides. */
  model?: string;
  modelSource?: ProviderMetadataSource;
  reasoningEffort?: string;
  reasoningEffortSource?: ProviderMetadataSource;
}

export interface ProviderQuotaMetadata {
  limit?: number;
  remaining?: number;
  reset?: string;
  headers?: Record<string, string>;
}

export interface ProviderRateLimitMetadata {
  limitRequests?: number;
  remainingRequests?: number;
  resetRequests?: string;
  limitTokens?: number;
  remainingTokens?: number;
  resetTokens?: string;
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
}

export interface ProviderResponseMetadata {
  capturedAt: string;
  quota?: ProviderQuotaMetadata;
  rateLimit?: ProviderRateLimitMetadata;
}

export interface ProviderRuntimeMetadata {
  providerName?: string;
  providerType?: ProviderType;
  model?: string;
  modelDisplayName?: string;
  modelSource?: ProviderMetadataSource;
  reasoningEffort?: string;
  config?: ProviderConfigMetadata;
  quota?: ProviderQuotaMetadata;
  rateLimit?: ProviderRateLimitMetadata;
  lastResponse?: ProviderResponseMetadata;
}

// ---------------------------------------------------------------------------
// Chat Chunk (streamed from provider)
// ---------------------------------------------------------------------------

export interface TextDeltaChunk {
  type: "text_delta";
  text: string;
}

export interface ReasoningDeltaChunk {
  type: "reasoning_delta";
  text: string;
}

export interface ToolCallStartChunk {
  type: "tool_call_start";
  toolCall: {
    id: string;
    name: string;
  };
}

export interface ToolCallDeltaChunk {
  type: "tool_call_delta";
  toolCallId: string;
  inputDelta: string; // partial JSON string
}

export interface ToolCallEndChunk {
  type: "tool_call_end";
  toolCallId: string;
}

export interface DoneChunk {
  type: "done";
  usage: Usage;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
  metadata?: ProviderResponseMetadata;
}

export type ChatChunk =
  | TextDeltaChunk
  | ReasoningDeltaChunk
  | ToolCallStartChunk
  | ToolCallDeltaChunk
  | ToolCallEndChunk
  | DoneChunk;

// ---------------------------------------------------------------------------
// LLM Provider Interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Display name (e.g. "claude", "gpt4", "local-llama") */
  readonly name: string;

  /** Provider type identifier */
  readonly type: ProviderType;

  /** Currently selected model ID */
  readonly model: string;

  /** Max context window size in tokens */
  readonly maxContextTokens: number;

  /** Whether this provider supports native tool calling */
  readonly supportsToolCalling: boolean;

  /** Whether this provider supports streaming responses */
  readonly supportsStreaming: boolean;

  /** Whether this provider supports future planning/evaluation workflows */
  readonly supportsPlanning: boolean;

  /** Optional safe observational metadata. Must not include tokens, prompts, or secrets. */
  readonly metadata?: ProviderRuntimeMetadata;

  /** Send a chat request and receive a stream of chunks */
  send(request: ChatRequest): AsyncIterable<ChatChunk>;

  /** Estimate token count for a string (optional, rough fallback if missing) */
  countTokens?(text: string): number;

  /** Optional safe metadata snapshot getter for providers with mutable runtime metadata. */
  getMetadata?(): ProviderRuntimeMetadata;
}

// ---------------------------------------------------------------------------
// Provider Configuration (loaded from providers.yml)
// ---------------------------------------------------------------------------

export type ProviderType =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openai-compatible"
  | "codex-backend"       // ChatGPT backend via ~/.codex/auth.json OAuth
  | "gemini-code-assist"  // Gemini via ~/.gemini/oauth_creds.json OAuth
  | "claude-cli"          // Local `claude` CLI fallback (non-streaming)
  | "gemini-cli"          // Local `gemini` CLI fallback (non-streaming)
  | "codex-cli";          // Local `codex` CLI fallback (non-streaming)

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  /** OAuth bearer token (alternative to apiKey; e.g. CLAUDE_CODE_OAUTH_TOKEN) */
  oauthToken?: string;
  /** Path to OAuth credentials file (e.g. ~/.codex/auth.json, ~/.gemini/oauth_creds.json) */
  oauthFile?: string;
  model: string;
  maxContextTokens?: number;
  planning?: boolean;
}

export interface ProviderOverride {
  provider?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Provider Registry Interface
// ---------------------------------------------------------------------------

export interface ProviderRegistry {
  /** Get provider by name */
  getProvider(name: string): LLMProvider;

  /** Get the provider config by name */
  getProviderConfig(name: string): ProviderConfig;

  /** List all registered provider names */
  listProviders(): string[];

  /** Get the default provider */
  getDefault(): LLMProvider;

  /** Get the default provider config */
  getDefaultProviderConfig(): ProviderConfig;

  /** Set the default provider by name */
  setDefault(name: string): void;

  /** Instantiate a child provider with optional provider/model override */
  instantiateProviderForChild(baseName: string, override?: ProviderOverride): LLMProvider;
}

// ---------------------------------------------------------------------------
// Model display normalization
// ---------------------------------------------------------------------------

const MODEL_DATE_SUFFIX = /[-_]\d{8}$/;

function toTitleWords(value: string): string {
  return value
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      if (part.toLowerCase() === "codex") return "Codex";
      if (part.toLowerCase() === "pro") return "Pro";
      if (part.toLowerCase() === "flash") return "Flash";
      if (part.toLowerCase() === "mini") return "mini";
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Compact display policy:
 * - keep unknown/local model IDs unchanged;
 * - strip provider date suffixes where common;
 * - preserve recognizable family casing for built-in cloud providers.
 */
export function normalizeModelDisplayName(
  providerType: ProviderType | string | undefined,
  model: string | undefined,
): string {
  const raw = model?.trim();
  if (!raw) return "(unknown model)";

  const compact = raw.replace(MODEL_DATE_SUFFIX, "");
  const provider = providerType ?? "";

  if (provider === "codex-backend" || provider === "openai") {
    const gpt = /^gpt[-_]?(.+)$/i.exec(compact);
    if (gpt) return `GPT-${toTitleWords(gpt[1]!).replace(/\s+/g, " ")}`;
    const oSeries = /^(o\d+(?:[-_].+)?)$/i.exec(compact);
    if (oSeries) return oSeries[1]!.replace(/[-_]+/g, " ");
  }

  if (provider === "anthropic") {
    const claudeDecimal = /^claude[-_](\d+)[-_](\d+)[-_](sonnet|opus|haiku)(?:[-_](\d+))?/i.exec(compact);
    if (claudeDecimal) {
      const version = claudeDecimal[4] ? ` ${claudeDecimal[4]}` : "";
      return `Claude ${claudeDecimal[1]}.${claudeDecimal[2]} ${toTitleWords(claudeDecimal[3]!)}${version}`;
    }
    const claude = /^claude[-_](.+)$/i.exec(compact);
    if (claude) return `Claude ${toTitleWords(claude[1]!)}`;
  }

  if (provider === "gemini" || provider === "gemini-code-assist") {
    const gemini = /^gemini[-_](.+)$/i.exec(compact);
    if (gemini) return `Gemini ${toTitleWords(gemini[1]!)}`;
  }

  return raw;
}
