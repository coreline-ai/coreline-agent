/**
 * Remote scheduler — dispatches tasks to a pool of remote endpoints with
 * windowed parallelism, retry with exponential backoff, and abort propagation.
 */

import type { Usage } from "../types.js";
import type {
  RemoteAgentEndpoint,
  RemoteBatchResult,
  RemoteSchedulerConfig,
  RemoteTaskRequest,
  RemoteTaskResult,
  RemoteTaskStatus,
  RetryPolicy,
} from "./types.js";
import {
  REMOTE_DEFAULT_MAX_CONCURRENT,
  REMOTE_DEFAULT_RETRY,
  REMOTE_DEFAULT_TIMEOUT_MS,
} from "./types.js";
import { checkEndpointHealth, sendRemoteTask } from "./client.js";

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

// ---------------------------------------------------------------------------
// Endpoint selection
// ---------------------------------------------------------------------------

/**
 * Round-robin endpoint picker. Prefers healthy endpoints but falls back
 * to unhealthy ones during retries (they may have recovered).
 */
function pickEndpoint(
  endpoints: RemoteAgentEndpoint[],
  index: number,
  allowUnhealthy = false,
): RemoteAgentEndpoint | null {
  const healthy = endpoints.filter((ep) => ep.healthy !== false);
  if (healthy.length > 0) return healthy[index % healthy.length]!;
  if (allowUnhealthy && endpoints.length > 0) {
    return endpoints[index % endpoints.length]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

function isRetryable(result: RemoteTaskResult): boolean {
  // Only retry transient failures (timeout, network errors).
  // Do not retry aborted (user-initiated) or completed tasks.
  if (result.status === "timeout") return true;
  if (result.status === "failed") {
    // Retry on network/server errors, not on auth or client errors
    if (result.error?.includes("HTTP 4")) return false;
    return true;
  }
  return false;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timeout);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class RemoteScheduler {
  private readonly endpoints: RemoteAgentEndpoint[];
  private readonly maxConcurrent: number;
  private readonly retry: RetryPolicy;
  private readonly defaultTimeoutMs: number;
  private roundRobinIndex = 0;

  constructor(config: Partial<RemoteSchedulerConfig> & { endpoints: RemoteAgentEndpoint[] }) {
    this.endpoints = config.endpoints;
    this.maxConcurrent = Math.max(1, config.maxConcurrent ?? REMOTE_DEFAULT_MAX_CONCURRENT);
    this.retry = config.retry ?? REMOTE_DEFAULT_RETRY;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? REMOTE_DEFAULT_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  /**
   * Ping all endpoints and update their `healthy` flag.
   * Returns the number of healthy endpoints.
   */
  async refreshHealth(): Promise<number> {
    const checks = this.endpoints.map(async (ep) => {
      ep.healthy = await checkEndpointHealth(ep);
    });
    await Promise.allSettled(checks);
    return this.endpoints.filter((ep) => ep.healthy).length;
  }

  get healthyCount(): number {
    return this.endpoints.filter((ep) => ep.healthy !== false).length;
  }

  // -----------------------------------------------------------------------
  // Single task (with retry)
  // -----------------------------------------------------------------------

  private async executeWithRetry(
    task: RemoteTaskRequest,
    signal?: AbortSignal,
  ): Promise<RemoteTaskResult> {
    const timeoutMs = task.timeoutMs ?? this.defaultTimeoutMs;
    let lastResult: RemoteTaskResult | null = null;

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      if (signal?.aborted) {
        return {
          endpoint: lastResult?.endpoint ?? "(none)",
          status: "aborted",
          text: "",
          usage: EMPTY_USAGE,
          error: "Aborted by parent",
          elapsedMs: 0,
        };
      }

      // On retry attempts, allow unhealthy endpoints (they may have recovered)
      const endpoint = pickEndpoint(this.endpoints, this.roundRobinIndex++, attempt > 0);
      if (!endpoint) {
        return {
          endpoint: "(no healthy endpoint)",
          status: "failed",
          text: "",
          usage: EMPTY_USAGE,
          error: "No healthy remote endpoints available",
          elapsedMs: 0,
        };
      }

      const result = await sendRemoteTask({
        endpoint,
        task,
        signal,
        timeoutMs,
      });

      if (result.status === "completed" || result.status === "aborted") {
        return result;
      }

      lastResult = result;

      // Mark endpoint as unhealthy on failure
      if (result.status === "failed" || result.status === "timeout") {
        endpoint.healthy = false;
      }

      // Retry?
      if (attempt < this.retry.maxRetries && isRetryable(result)) {
        const backoff = this.retry.backoffMs * Math.pow(2, attempt);
        await sleep(backoff, signal);
        continue;
      }

      return result;
    }

    // Should not reach here, but just in case
    return lastResult ?? {
      endpoint: "(unknown)",
      status: "failed",
      text: "",
      usage: EMPTY_USAGE,
      error: "Exhausted retry attempts",
      elapsedMs: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Batch execution
  // -----------------------------------------------------------------------

  /**
   * Execute multiple tasks with windowed parallelism.
   *
   * Tasks are dispatched in windows of `maxConcurrent`. If the parent
   * signal is aborted, remaining tasks are marked as aborted.
   */
  async schedule(
    tasks: RemoteTaskRequest[],
    signal?: AbortSignal,
  ): Promise<RemoteBatchResult> {
    if (tasks.length === 0) {
      return {
        results: [],
        totalUsage: EMPTY_USAGE,
        completedCount: 0,
        failedCount: 0,
        partial: false,
      };
    }

    const results: RemoteTaskResult[] = [];

    for (let start = 0; start < tasks.length; start += this.maxConcurrent) {
      if (signal?.aborted) {
        // Mark remaining tasks as aborted
        for (let i = start; i < tasks.length; i++) {
          results.push({
            endpoint: "(skipped)",
            status: "aborted",
            text: "",
            usage: EMPTY_USAGE,
            error: "Aborted before dispatch",
            elapsedMs: 0,
          });
        }
        break;
      }

      const window = tasks.slice(start, start + this.maxConcurrent);
      const settled = await Promise.allSettled(
        window.map((task) => this.executeWithRetry(task, signal)),
      );

      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          results.push(outcome.value);
        } else {
          const message = outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
          results.push({
            endpoint: "(unknown)",
            status: "failed",
            text: "",
            usage: EMPTY_USAGE,
            error: message,
            elapsedMs: 0,
          });
        }
      }

      // If abort happened mid-window, remaining windows will catch it at the top
    }

    return buildBatchResult(results);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBatchResult(results: RemoteTaskResult[]): RemoteBatchResult {
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let completedCount = 0;
  let failedCount = 0;

  for (const r of results) {
    totalUsage.inputTokens += r.usage.inputTokens;
    totalUsage.outputTokens += r.usage.outputTokens;
    totalUsage.totalTokens += r.usage.totalTokens;
    if (r.status === "completed") {
      completedCount++;
    } else {
      failedCount++;
    }
  }

  return {
    results,
    totalUsage,
    completedCount,
    failedCount,
    partial: failedCount > 0 && completedCount > 0,
  };
}
