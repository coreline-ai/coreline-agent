/**
 * Claude CLI fallback provider.
 *
 * Spawns the local `claude` binary with `-p <prompt> --output-format json`
 * and converts its single-shot JSON response to our ChatChunk stream.
 *
 * Use when the Anthropic API is unavailable (no OAuth token / no API key)
 * but the user has Claude Code installed locally. Tool calling is NOT
 * supported in this fallback — the CLI is treated as a text oracle.
 */

import type { Usage } from "../agent/types.js";
import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
} from "./types.js";
import {
  estimateTokens,
  extractJsonObject,
  flattenMessagesToPrompt,
  runCli,
} from "./cli-shared.js";

interface ClaudeCliJson {
  result?: string;
  response?: string;
  text?: string;
  content?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name: string;
  readonly type = "claude-cli" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = false;
  readonly supportsPlanning = false;
  readonly supportsStreaming = false;

  private binary: string;
  private extraArgs: string[];

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model || "claude";
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    // `baseUrl` is repurposed here as the binary path override (e.g. /usr/local/bin/claude)
    this.binary = config.baseUrl ?? "claude";
    // Config `oauthToken` is repurposed as extra CLI args, space-separated,
    // so callers can pass `--permission-mode plan` etc. via YAML without a
    // schema change. Empty by default.
    this.extraArgs = config.oauthToken
      ? config.oauthToken.split(/\s+/).filter(Boolean)
      : [];
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const prompt = flattenMessagesToPrompt(
      request.messages,
      request.systemPrompt,
    );

    const cmd = [
      this.binary,
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      this.model,
      ...this.extraArgs,
    ];

    let result;
    try {
      result = await runCli({ cmd, signal: request.signal });
    } catch (err) {
      throw new Error(
        `[${this.name}] claude CLI spawn failed: ${(err as Error).message}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `[${this.name}] claude CLI exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const parsed = extractJsonObject(result.stdout) as ClaudeCliJson | null;
    const text =
      parsed?.result ??
      parsed?.response ??
      parsed?.text ??
      parsed?.content ??
      result.stdout.trim();

    const usage: Usage = {
      inputTokens:
        parsed?.usage?.input_tokens ?? estimateTokens(prompt),
      outputTokens:
        parsed?.usage?.output_tokens ?? estimateTokens(text),
      totalTokens: 0,
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;

    if (text) {
      yield { type: "text_delta", text };
    }
    yield { type: "done", usage, stopReason: "end_turn" };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}
