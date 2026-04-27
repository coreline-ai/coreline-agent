/**
 * Remote agent HTTP client — sends a single task to one remote endpoint
 * using the Anthropic Messages API format (POST /v1/messages).
 *
 * The response is parsed into a RemoteTaskResult regardless of whether the
 * remote is an actual Anthropic API or a coreline-agent-proxy that translates
 * internally.
 */

import type { Usage } from "../types.js";
import type {
  RemoteAgentEndpoint,
  RemoteTaskRequest,
  RemoteTaskResult,
  RemoteTaskStatus,
} from "./types.js";

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function buildRequestBody(task: RemoteTaskRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: task.model ?? "default",
    messages: [
      { role: "user", content: task.prompt },
    ],
    max_tokens: task.maxTokens ?? 4096,
    stream: false,
  };

  if (task.systemPrompt) {
    body.system = task.systemPrompt;
  }
  if (task.temperature !== undefined) {
    body.temperature = task.temperature;
  }

  return body;
}

function buildHeaders(endpoint: RemoteAgentEndpoint): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (endpoint.authToken) {
    headers["authorization"] = `Bearer ${endpoint.authToken}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractTextFromAnthropicResponse(data: Record<string, unknown>): string {
  const content = data.content as Array<{ type: string; text?: string }> | undefined;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("");
}

function extractUsageFromAnthropicResponse(data: Record<string, unknown>): Usage {
  const usage = data.usage as Record<string, number> | undefined;
  if (!usage) return EMPTY_USAGE;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

function extractModelFromResponse(data: Record<string, unknown>): string | undefined {
  return typeof data.model === "string" ? data.model : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendTaskOptions {
  endpoint: RemoteAgentEndpoint;
  task: RemoteTaskRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Send a single task to a remote endpoint and return a structured result.
 *
 * Never throws — all errors are captured in the returned RemoteTaskResult
 * with an appropriate status.
 */
export async function sendRemoteTask(options: SendTaskOptions): Promise<RemoteTaskResult> {
  const { endpoint, task, signal, timeoutMs } = options;
  const startMs = Date.now();

  // Compose abort: parent signal + per-task timeout
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const onParentAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      return makeResult(endpoint, "aborted", "", EMPTY_USAGE, startMs, undefined, "Aborted before start");
    }
    signal.addEventListener("abort", onParentAbort, { once: true });
  }
  if (timeoutMs && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    const url = `${endpoint.url.replace(/\/$/, "")}/v1/messages`;
    const body = buildRequestBody(task);
    const headers = buildHeaders(endpoint);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const status: RemoteTaskStatus = response.status === 401 ? "failed" : "failed";
      return makeResult(
        endpoint,
        status,
        "",
        EMPTY_USAGE,
        startMs,
        undefined,
        `HTTP ${response.status}: ${truncate(errText)}`,
        response.headers.get("x-request-id") ?? undefined,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const text = extractTextFromAnthropicResponse(data);
    const usage = extractUsageFromAnthropicResponse(data);
    const model = extractModelFromResponse(data);
    const requestId = response.headers.get("x-request-id") ?? undefined;

    return makeResult(endpoint, "completed", text, usage, startMs, model, undefined, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (timedOut) {
      return makeResult(endpoint, "timeout", "", EMPTY_USAGE, startMs, undefined, `Timeout after ${timeoutMs}ms`);
    }
    if (signal?.aborted) {
      return makeResult(endpoint, "aborted", "", EMPTY_USAGE, startMs, undefined, "Aborted by parent");
    }

    return makeResult(endpoint, "failed", "", EMPTY_USAGE, startMs, undefined, message);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Ping a remote endpoint's /health to check reachability.
 * Returns true if HTTP 200 within 3 seconds.
 */
export async function checkEndpointHealth(
  endpoint: RemoteAgentEndpoint,
  timeoutMs = 3_000,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${endpoint.url.replace(/\/$/, "")}/health`;
    const headers: Record<string, string> = {};
    if (endpoint.authToken) {
      headers["authorization"] = `Bearer ${endpoint.authToken}`;
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  endpoint: RemoteAgentEndpoint,
  status: RemoteTaskStatus,
  text: string,
  usage: Usage,
  startMs: number,
  model?: string,
  error?: string,
  requestId?: string,
): RemoteTaskResult {
  return {
    endpoint: endpoint.name,
    status,
    text,
    usage,
    model,
    error,
    elapsedMs: Date.now() - startMs,
    requestId,
  };
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}
