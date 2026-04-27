/**
 * RemoteSubAgentRuntime — wraps RemoteScheduler as a SubAgentRuntime
 * so that AgentTool can transparently dispatch to remote endpoints
 * when `request.provider` matches a remote scheduler name, or when
 * the parent SubAgentRuntime delegates via providerResolver.
 *
 * This is a drop-in alternative to DefaultSubAgentRuntime for remote tasks.
 * It converts SubAgentRequest → RemoteTaskRequest[], dispatches via
 * RemoteScheduler, and converts RemoteTaskResult[] → SubAgentResult.
 */

import type { Usage } from "../types.js";
import type { ToolUseContext } from "../../tools/types.js";
import { runPipeline } from "../pipeline-runner.js";
import type { PipelineStageExecResult } from "../pipeline-runner.js";
import type {
  SubAgentRequest,
  SubAgentResult,
  SubAgentChildResult,
  SubAgentChildStatus,
  SubAgentFailure,
  SubAgentTaskRequest,
  SubAgentRuntime,
} from "../subagent-types.js";
import type {
  RemoteAgentEndpoint,
  RemoteSchedulerConfig,
  RemoteTaskRequest,
  RemoteTaskResult,
} from "./types.js";
import { RemoteScheduler } from "./scheduler.js";

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const MAX_SUMMARY_CHARS = 240;

function truncateSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "(no response)";
  if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Conversion: SubAgentRequest → RemoteTaskRequest
// ---------------------------------------------------------------------------

function toRemoteTask(task: SubAgentTaskRequest, defaults?: Partial<SubAgentRequest>): RemoteTaskRequest {
  return {
    prompt: task.prompt,
    model: task.model ?? defaults?.model,
    tools: task.allowedTools ?? defaults?.allowedTools,
    maxTokens: undefined,
    temperature: undefined,
    timeoutMs: task.timeoutMs ?? defaults?.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Conversion: RemoteTaskResult → SubAgentChildResult
// ---------------------------------------------------------------------------

function toChildResult(
  remote: RemoteTaskResult,
  task: SubAgentTaskRequest,
  index: number,
): SubAgentChildResult {
  const statusMap: Record<string, SubAgentChildStatus> = {
    completed: "completed",
    failed: "failed",
    timeout: "timeout",
    aborted: "aborted",
  };

  return {
    id: `remote-${index + 1}`,
    prompt: task.prompt,
    status: statusMap[remote.status] ?? "failed",
    provider: remote.endpoint,
    model: remote.model,
    write: false, // remote tasks are always read-only
    finalText: remote.text,
    summary: truncateSummary(remote.text || remote.error || remote.status),
    turns: 1, // remote is single-shot
    usedTools: [], // remote doesn't report tool usage in this layer
    usage: remote.usage,
    reason: remote.status === "completed" ? "completed" : remote.error ?? remote.status,
    error: remote.status !== "completed" ? remote.error : undefined,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class RemoteSubAgentRuntime implements SubAgentRuntime {
  private readonly scheduler: RemoteScheduler;

  constructor(config: Partial<RemoteSchedulerConfig> & { endpoints: RemoteAgentEndpoint[] }) {
    this.scheduler = new RemoteScheduler(config);
  }

  async run(request: SubAgentRequest, context: ToolUseContext): Promise<SubAgentResult> {
    // Pipeline mode: sequential handoff chain via remote
    if (request.pipeline && request.pipeline.length > 0) {
      return this.runRemotePipeline(request, context);
    }

    // If subtasks are provided, dispatch all of them
    if (request.subtasks && request.subtasks.length > 0) {
      return this.runMany(request.subtasks, context, request);
    }

    // Single task
    const remoteTasks = [toRemoteTask(request)];
    const batch = await this.scheduler.schedule(remoteTasks, context.abortSignal);
    const child = toChildResult(batch.results[0]!, request, 0);

    return {
      finalText: child.finalText,
      summary: child.summary,
      turns: child.turns,
      usedTools: child.usedTools,
      usage: child.usage,
      reason: child.reason,
    };
  }

  async runMany(
    requests: SubAgentTaskRequest[],
    context: ToolUseContext,
    parentRequest?: SubAgentRequest,
  ): Promise<SubAgentResult> {
    const remoteTasks = requests.map((r) => toRemoteTask(r, parentRequest));
    const batch = await this.scheduler.schedule(remoteTasks, context.abortSignal);

    const children: SubAgentChildResult[] = batch.results.map((r, i) =>
      toChildResult(r, requests[i]!, i),
    );

    const failures: SubAgentFailure[] = children
      .filter((c) => c.status !== "completed")
      .map((c) => ({
        id: c.id,
        prompt: c.prompt,
        status: c.status as Exclude<SubAgentChildStatus, "completed">,
        provider: c.provider,
        model: c.model,
        write: false,
        message: c.error ?? c.summary,
      }));

    const lines = [
      "REMOTE_COORDINATOR_RESULT",
      `children: ${children.length}`,
      `completed: ${batch.completedCount}`,
      `failed: ${batch.failedCount}`,
      "",
      ...children.map((c) =>
        `- [${c.status}] ${c.id}: ${c.prompt}\n  summary: ${c.summary}`,
      ),
    ];

    const finalText = lines.join("\n");

    return {
      finalText,
      summary: truncateSummary(finalText),
      turns: children.reduce((sum, c) => sum + c.turns, 0),
      usedTools: [],
      usage: batch.totalUsage,
      reason: batch.failedCount > 0
        ? (batch.completedCount > 0 ? "error" : "error")
        : "completed",
      coordinator: true,
      partial: batch.partial,
      childCount: children.length,
      completedCount: batch.completedCount,
      failedCount: batch.failedCount,
      children,
      failures: failures.length > 0 ? failures : undefined,
    };
  }

  private async runRemotePipeline(
    request: SubAgentRequest,
    context: ToolUseContext,
  ): Promise<SubAgentResult> {
    const stages = request.pipeline!;

    const executor = async (
      req: { prompt: string; provider?: string; model?: string; timeoutMs?: number },
      signal?: AbortSignal,
    ): Promise<PipelineStageExecResult> => {
      const remoteTask = {
        prompt: req.prompt,
        model: req.model ?? request.model,
        timeoutMs: req.timeoutMs,
      };
      const batch = await this.scheduler.schedule([remoteTask], signal);
      const r = batch.results[0]!;
      return {
        status: r.status === "completed" ? "completed" : r.status === "timeout" ? "timeout" : r.status === "aborted" ? "aborted" : "failed",
        text: r.text,
        usage: r.usage,
        provider: r.endpoint,
        model: r.model,
        error: r.error,
      };
    };

    const result = await runPipeline(
      { stages, goal: request.prompt, onStageFailure: "stop", defaultTimeoutMs: request.timeoutMs },
      executor,
      context.abortSignal,
    );

    const lines = [
      "REMOTE_PIPELINE_RESULT",
      `goal: ${request.prompt}`,
      `stages: ${result.stages.length}`,
      `completed: ${result.completedCount}`,
      `failed: ${result.failedCount}`,
      "",
      ...result.stages.map(
        (s) => `- stage-${s.stageIndex + 1} [${s.status}]: ${s.prompt}${s.error ? ` (${s.error})` : ""}`,
      ),
    ];
    if (result.finalText) {
      lines.push("", "FINAL_OUTPUT", result.finalText);
    }
    const finalText = lines.join("\n");

    return {
      finalText,
      summary: truncateSummary(finalText),
      turns: result.stages.length,
      usedTools: [],
      usage: result.totalUsage,
      reason: result.success ? "completed" : "error",
      coordinator: true,
      partial: result.failedCount > 0 && result.completedCount > 0,
      childCount: result.stages.length,
      completedCount: result.completedCount,
      failedCount: result.failedCount,
    };
  }

  /**
   * Convenience: refresh health of all endpoints.
   */
  async refreshHealth(): Promise<number> {
    return this.scheduler.refreshHealth();
  }
}
