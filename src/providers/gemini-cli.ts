/**
 * Gemini CLI fallback provider.
 *
 * Spawns the local `gemini` binary with `-p <prompt> -o json` and converts
 * its output to our ChatChunk stream. Use when the Gemini API / Code Assist
 * endpoints are unavailable but the user has the `gemini` CLI installed.
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

interface GeminiCliJson {
  response?: string;
  text?: string;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export class GeminiCliProvider implements LLMProvider {
  readonly name: string;
  readonly type = "gemini-cli" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = false;
  readonly supportsPlanning = false;
  readonly supportsStreaming = false;

  private binary: string;
  private extraArgs: string[];

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model || "gemini-2.5-pro";
    this.maxContextTokens = config.maxContextTokens ?? 1_000_000;
    this.binary = config.baseUrl ?? "gemini";
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
      "-o",
      "json",
      "-m",
      this.model,
      ...this.extraArgs,
    ];

    let result;
    try {
      result = await runCli({ cmd, signal: request.signal });
    } catch (err) {
      throw new Error(
        `[${this.name}] gemini CLI spawn failed: ${(err as Error).message}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `[${this.name}] gemini CLI exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const parsed = extractJsonObject(result.stdout) as GeminiCliJson | null;
    const text =
      parsed?.response ??
      parsed?.text ??
      parsed?.result ??
      result.stdout.trim();

    const usage: Usage = {
      inputTokens:
        parsed?.usage?.input_tokens ??
        parsed?.usage?.promptTokenCount ??
        estimateTokens(prompt),
      outputTokens:
        parsed?.usage?.output_tokens ??
        parsed?.usage?.candidatesTokenCount ??
        estimateTokens(text),
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
