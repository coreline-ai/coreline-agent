/**
 * Pipeline runner — executes stages sequentially, injecting each stage's
 * result into the next stage's prompt as context.
 *
 * Works with any executor that accepts (prompt, options) → text result.
 * Both SubAgentRuntime (local) and RemoteScheduler (HTTP) can be wrapped
 * as a PipelineExecutor.
 */

import type { Usage } from "./types.js";
import type {
  PipelineRequest,
  PipelineResult,
  PipelineStage,
  PipelineStageResult,
  PipelineStageStatus,
} from "./pipeline-types.js";
import {
  PIPELINE_DEFAULT_CONTEXT_PREFIX,
  PIPELINE_DEFAULT_TIMEOUT_MS,
} from "./pipeline-types.js";

// ---------------------------------------------------------------------------
// Executor interface — abstraction over local/remote execution
// ---------------------------------------------------------------------------

export interface PipelineStageExecRequest {
  prompt: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
  contracts?: string[];
  mergeNotes?: string;
}

export interface PipelineStageExecResult {
  status: "completed" | "failed" | "timeout" | "aborted";
  text: string;
  usage: Usage;
  provider: string;
  model?: string;
  error?: string;
}

/**
 * A function that executes a single pipeline stage.
 * Implementations wrap SubAgentRuntime.run() or RemoteScheduler.sendRemoteTask().
 */
export type PipelineExecutor = (
  request: PipelineStageExecRequest,
  signal?: AbortSignal,
) => Promise<PipelineStageExecResult>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function buildStagePrompt(
  stage: PipelineStage,
  previousResult: string | null,
  goal: string | undefined,
): string {
  const parts: string[] = [];

  if (goal) {
    parts.push(`[Pipeline Goal] ${goal}`);
  }

  if (previousResult !== null) {
    const prefix = stage.contextPrefix ?? PIPELINE_DEFAULT_CONTEXT_PREFIX;
    parts.push(`${prefix}${previousResult}`);
  }

  parts.push(stage.prompt);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute a pipeline: stages run sequentially, each receiving the previous
 * stage's text result as context in its prompt.
 *
 * @param request   Pipeline definition (stages, goal, failure policy)
 * @param executor  Function that runs a single stage
 * @param signal    Optional abort signal (propagated to all stages)
 */
export async function runPipeline(
  request: PipelineRequest,
  executor: PipelineExecutor,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const { stages, goal, onStageFailure = "stop", defaultTimeoutMs } = request;

  if (stages.length === 0) {
    return {
      stages: [],
      finalText: "",
      totalUsage: EMPTY_USAGE,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      success: true,
    };
  }

  const results: PipelineStageResult[] = [];
  let totalUsage: Usage = { ...EMPTY_USAGE };
  let previousText: string | null = null;
  let lastCompletedText = "";
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let stopped = false;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;

    // Check abort before each stage
    if (signal?.aborted || stopped) {
      const status: PipelineStageStatus = signal?.aborted ? "aborted" : "skipped";
      if (status === "aborted") {
        // Mark all remaining as aborted
        for (let j = i; j < stages.length; j++) {
          results.push({
            stageIndex: j,
            prompt: stages[j]!.prompt,
            status: "aborted",
            text: "",
            usage: EMPTY_USAGE,
            provider: "",
            elapsedMs: 0,
            error: "Pipeline aborted",
          });
        }
        break;
      }
      // stopped due to prior failure + stop policy
      results.push({
        stageIndex: i,
        prompt: stage.prompt,
        status: "skipped",
        text: "",
        usage: EMPTY_USAGE,
        provider: "",
        elapsedMs: 0,
        error: "Skipped due to prior stage failure",
      });
      skippedCount++;
      continue;
    }

    const fullPrompt = buildStagePrompt(stage, previousText, goal);
    const timeoutMs = stage.timeoutMs ?? defaultTimeoutMs ?? PIPELINE_DEFAULT_TIMEOUT_MS;
    const startMs = Date.now();

    try {
      const execResult = await executor(
        {
          prompt: fullPrompt,
          provider: stage.provider,
          model: stage.model,
          timeoutMs,
          allowedTools: stage.allowedTools,
          ownedPaths: stage.ownedPaths,
          nonOwnedPaths: stage.nonOwnedPaths,
          contracts: stage.contracts,
          mergeNotes: stage.mergeNotes,
        },
        signal,
      );

      const elapsedMs = Date.now() - startMs;
      const stageResult: PipelineStageResult = {
        stageIndex: i,
        prompt: stage.prompt,
        status: execResult.status === "completed" ? "completed" : "failed",
        text: execResult.text,
        usage: execResult.usage,
        provider: execResult.provider,
        model: execResult.model,
        elapsedMs,
        error: execResult.error,
      };
      results.push(stageResult);
      totalUsage = addUsage(totalUsage, execResult.usage);

      if (execResult.status === "completed") {
        completedCount++;
        previousText = execResult.text;
        lastCompletedText = execResult.text;
      } else {
        failedCount++;
        if (onStageFailure === "stop") {
          stopped = true;
          // Mark remaining stages as skipped
        } else {
          // skip: don't update previousText, next stage gets last good result
        }
      }
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);

      if (signal?.aborted) {
        results.push({
          stageIndex: i,
          prompt: stage.prompt,
          status: "aborted",
          text: "",
          usage: EMPTY_USAGE,
          provider: "",
          elapsedMs,
          error: "Pipeline aborted",
        });
        // Mark rest as aborted
        for (let j = i + 1; j < stages.length; j++) {
          results.push({
            stageIndex: j,
            prompt: stages[j]!.prompt,
            status: "aborted",
            text: "",
            usage: EMPTY_USAGE,
            provider: "",
            elapsedMs: 0,
            error: "Pipeline aborted",
          });
        }
        break;
      }

      failedCount++;
      results.push({
        stageIndex: i,
        prompt: stage.prompt,
        status: "failed",
        text: "",
        usage: EMPTY_USAGE,
        provider: "",
        elapsedMs,
        error: message,
      });

      if (onStageFailure === "stop") {
        stopped = true;
      }
    }
  }

  // Count remaining skipped if stopped
  skippedCount = results.filter((r) => r.status === "skipped").length;

  return {
    stages: results,
    finalText: lastCompletedText,
    totalUsage,
    completedCount,
    failedCount,
    skippedCount,
    success: failedCount === 0 && results.every((r) => r.status !== "aborted"),
  };
}
