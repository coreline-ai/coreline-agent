/**
 * CLI provider shared utilities.
 *
 * Used by claude-cli / gemini-cli / codex-cli providers to spawn the
 * upstream binary (`claude`, `gemini`, `codex`) and convert its output
 * into our ChatChunk stream.
 *
 * Streaming model: these CLIs do not emit incremental SSE, so we run the
 * binary to completion, then emit a single synthetic text_delta + done pair.
 * This is enough for proxy round-tripping but loses incremental UX.
 */

import type { ChatMessage, ContentBlock, Usage } from "../agent/types.js";
import type { ChatChunk } from "./types.js";

// ---------------------------------------------------------------------------
// Message flattening — CLI transports accept only a single prompt string
// ---------------------------------------------------------------------------

/**
 * Flatten an assistant/user chat history into a single text prompt.
 *
 * Tool calls and tool results are rendered as human-readable markers so the
 * CLI has some awareness of prior turns, even without native tool support.
 */
export function flattenMessagesToPrompt(
  messages: ChatMessage[],
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`[system]\n${systemPrompt}`);
  }
  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(`[system]\n${msg.content}`);
      continue;
    }
    const role = msg.role === "user" ? "user" : "assistant";
    parts.push(`[${role}]\n${renderContent(msg.content)}`);
  }
  return parts.join("\n\n");
}

function renderContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  const out: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        out.push(block.text);
        break;
      case "tool_use":
        out.push(
          `<tool_use name="${block.name}" id="${block.id}">${JSON.stringify(block.input)}</tool_use>`,
        );
        break;
      case "tool_result":
        out.push(
          `<tool_result id="${block.toolUseId}"${block.isError ? ' error="true"' : ""}>${block.content}</tool_result>`,
        );
        break;
      case "image":
        out.push(`<image media_type="${block.mediaType}" />`);
        break;
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Bun spawn wrapper
// ---------------------------------------------------------------------------

export interface CliSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliSpawnOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Optional stdin payload written before closing the pipe */
  stdin?: string;
  signal?: AbortSignal;
  /** Timeout in ms (default 10 min) */
  timeoutMs?: number;
}

export async function runCli(options: CliSpawnOptions): Promise<CliSpawnResult> {
  const { cmd, cwd, env, stdin, signal, timeoutMs = 10 * 60 * 1000 } = options;

  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(env ?? {}),
  };

  const proc = Bun.spawn({
    cmd,
    cwd,
    env: mergedEnv,
    stdin: stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (stdin !== undefined && proc.stdin) {
    try {
      await proc.stdin.write(stdin);
      await proc.stdin.end();
    } catch {
      // ignore, process may have exited fast
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      aborted = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  }

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (signal) signal.removeEventListener("abort", onAbort);

  if (aborted) {
    throw new Error(
      `CLI command aborted: ${cmd.join(" ")} (exit=${exitCode}, stderr=${truncate(stderrText)})`,
    );
  }

  return { stdout: stdoutText, stderr: stderrText, exitCode };
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

// ---------------------------------------------------------------------------
// Generic "emit single text_delta + done" helper
// ---------------------------------------------------------------------------

export function *yieldSingleText(
  text: string,
  usage: Usage,
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" = "end_turn",
): Generator<ChatChunk> {
  if (text) {
    yield { type: "text_delta", text };
  }
  yield { type: "done", usage, stopReason };
}

// ---------------------------------------------------------------------------
// JSON extraction — CLIs sometimes wrap output with log lines; find the
// first top-level JSON object in stdout.
// ---------------------------------------------------------------------------

export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Fast path: pure JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fallback to scanning */
  }

  // Scan for first balanced `{...}` at top level
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // keep scanning
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rough token estimator (used when CLI does not report usage)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
