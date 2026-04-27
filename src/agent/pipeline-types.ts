/**
 * Pipeline types — sequential handoff chain where each stage's result
 * becomes the next stage's context.
 *
 * Level 1 pipeline: explicit stage order, no LLM routing.
 * Each stage runs via SubAgentRuntime or RemoteScheduler.
 */

import type { Usage } from "./types.js";

// ---------------------------------------------------------------------------
// Stage definition
// ---------------------------------------------------------------------------

export interface PipelineStage {
  /** Prompt for this stage */
  prompt: string;
  /** Prefix injected before the previous stage's result (default: "Previous stage result:\n") */
  contextPrefix?: string;
  /** Files this stage owns for parallel coordination */
  ownedPaths?: string[];
  /** Files this stage may reference but not edit */
  nonOwnedPaths?: string[];
  /** Shared contracts or handoff rules */
  contracts?: string[];
  /** Merge guidance for this stage */
  mergeNotes?: string;
  /** Provider override for this stage (optional) */
  provider?: string;
  /** Model override for this stage (optional) */
  model?: string;
  /** Timeout for this stage in ms (optional, falls back to pipeline-level default) */
  timeoutMs?: number;
  /** Allowed tools for this stage (optional) */
  allowedTools?: string[];
}

// ---------------------------------------------------------------------------
// Pipeline request
// ---------------------------------------------------------------------------

export interface PipelineRequest {
  /** Ordered stages — executed sequentially, each receiving the prior result */
  stages: PipelineStage[];
  /** Overall goal description (injected into each stage's system context) */
  goal?: string;
  /** What to do when a stage fails: "stop" (default) or "skip" */
  onStageFailure?: "stop" | "skip";
  /** Default timeout per stage in ms (overridden by per-stage timeoutMs) */
  defaultTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Stage result
// ---------------------------------------------------------------------------

export type PipelineStageStatus = "completed" | "failed" | "skipped" | "aborted";

export interface PipelineStageResult {
  stageIndex: number;
  prompt: string;
  status: PipelineStageStatus;
  text: string;
  usage: Usage;
  provider: string;
  model?: string;
  elapsedMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface PipelineResult {
  /** Per-stage results, ordered same as input stages */
  stages: PipelineStageResult[];
  /** Text from the last completed stage */
  finalText: string;
  /** Aggregated usage across all stages */
  totalUsage: Usage;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  /** Whether all stages completed successfully */
  success: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const PIPELINE_DEFAULT_CONTEXT_PREFIX = "Previous stage result:\n";
export const PIPELINE_DEFAULT_TIMEOUT_MS = 120_000;
