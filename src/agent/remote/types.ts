/**
 * Remote agent types — contracts for dispatching tasks to external
 * coreline-agent-proxy instances (or any Anthropic/OpenAI-compatible endpoint).
 */

import type { Usage } from "../types.js";

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export interface RemoteAgentEndpoint {
  /** Human-readable name for logs and debug records */
  name: string;
  /** Base URL, e.g. "http://10.0.1.5:4317" */
  url: string;
  /** Optional bearer token for the remote proxy */
  authToken?: string;
  /** Capabilities declared by the remote (from /v2/capabilities) */
  capabilities?: string[];
  /** Whether this endpoint is currently reachable (runtime state) */
  healthy?: boolean;
}

// ---------------------------------------------------------------------------
// Task request / result
// ---------------------------------------------------------------------------

export interface RemoteTaskRequest {
  /** Prompt text for the remote agent */
  prompt: string;
  /** Model to request on the remote side (the remote picks a provider) */
  model?: string;
  /** System prompt override */
  systemPrompt?: string;
  /** Optional tool subset (function names) */
  tools?: string[];
  /** Max tokens for the response */
  maxTokens?: number;
  /** Temperature override */
  temperature?: number;
  /** Per-task timeout in ms (default: scheduler-level timeout) */
  timeoutMs?: number;
}

export type RemoteTaskStatus = "completed" | "failed" | "timeout" | "aborted";

export interface RemoteTaskResult {
  /** Which endpoint handled this task */
  endpoint: string;
  /** Outcome status */
  status: RemoteTaskStatus;
  /** Response text (empty on failure) */
  text: string;
  /** Token usage reported by the remote */
  usage: Usage;
  /** Model that actually served the request (from the remote response) */
  model?: string;
  /** Error message if status !== "completed" */
  error?: string;
  /** Elapsed wall time in ms */
  elapsedMs: number;
  /** Request ID from the remote (X-Request-Id header) */
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Scheduler config
// ---------------------------------------------------------------------------

export interface RemoteSchedulerConfig {
  /** Available remote endpoints */
  endpoints: RemoteAgentEndpoint[];
  /** Maximum tasks to run concurrently across all endpoints */
  maxConcurrent: number;
  /** Retry policy for transient failures */
  retry: RetryPolicy;
  /** Default per-task timeout in ms (overridden by per-task timeoutMs) */
  defaultTimeoutMs: number;
}

export interface RetryPolicy {
  /** Maximum retries per task (0 = no retry) */
  maxRetries: number;
  /** Base backoff delay in ms (doubled on each retry) */
  backoffMs: number;
}

// ---------------------------------------------------------------------------
// Batch result
// ---------------------------------------------------------------------------

export interface RemoteBatchResult {
  /** Individual task results, ordered same as input */
  results: RemoteTaskResult[];
  /** Aggregated usage */
  totalUsage: Usage;
  /** Count by status */
  completedCount: number;
  failedCount: number;
  /** Whether any task failed */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const REMOTE_DEFAULT_MAX_CONCURRENT = 4;
export const REMOTE_DEFAULT_TIMEOUT_MS = 60_000;
export const REMOTE_DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 1,
  backoffMs: 1_000,
};
