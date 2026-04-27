/**
 * Codex CLI fallback provider.
 *
 * Spawns the local `codex` binary in non-interactive exec mode and captures
 * stdout as the assistant text. The `codex` CLI does not have a stable JSON
 * output mode across versions, so we strip ANSI and treat the final stdout
 * as plain text.
 *
 * Primary Codex path remains `codex-backend.ts` (OAuth direct). Use this CLI
 * fallback only when OAuth tokens are unavailable or refresh fails.
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
  flattenMessagesToPrompt,
  runCli,
} from "./cli-shared.js";

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export class CodexCliProvider implements LLMProvider {
  readonly name: string;
  readonly type = "codex-cli" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = false;
  readonly supportsPlanning = false;
  readonly supportsStreaming = false;

  private binary: string;
  private extraArgs: string[];

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model || "gpt-5";
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    this.binary = config.baseUrl ?? "codex";
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
      "exec",
      "--skip-git-repo-check",
      "--model",
      this.model,
      ...this.extraArgs,
      prompt,
    ];

    let result;
    try {
      result = await runCli({ cmd, signal: request.signal });
    } catch (err) {
      throw new Error(
        `[${this.name}] codex CLI spawn failed: ${(err as Error).message}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `[${this.name}] codex CLI exited ${result.exitCode}: ${stripAnsi(result.stderr).trim() || stripAnsi(result.stdout).trim()}`,
      );
    }

    const text = stripAnsi(result.stdout).trim();

    const usage: Usage = {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(text),
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
