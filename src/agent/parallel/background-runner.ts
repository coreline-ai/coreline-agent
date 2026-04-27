import type { ToolUseContext } from "../../tools/types.js";
import type { SubAgentRequest, SubAgentRuntime } from "../subagent-types.js";
import type { ParallelAgentTaskRecord } from "./types.js";
import { ParallelAgentScheduler } from "./scheduler.js";
import { createParallelAgentProgressSink } from "./progress.js";
import { normalizeParallelAgentResult } from "./structured-result.js";

export interface StartParallelAgentBackgroundTaskInput {
  scheduler: ParallelAgentScheduler;
  runtime: SubAgentRuntime;
  context: ToolUseContext;
  request: SubAgentRequest;
  description?: string;
}

function taskProviderName(context: ToolUseContext, request: SubAgentRequest): string {
  return request.provider ?? context.providerName ?? "parent";
}

function taskModel(context: ToolUseContext, request: SubAgentRequest): string | undefined {
  return request.model ?? context.providerModel;
}

export function startParallelAgentBackgroundTask(
  input: StartParallelAgentBackgroundTaskInput,
): ParallelAgentTaskRecord {
  const { scheduler, runtime, context, request, description } = input;
  const { task, completion } = scheduler.submitTask(
    {
      prompt: request.prompt,
      description,
      cwd: context.cwd,
      provider: taskProviderName(context, request),
      model: taskModel(context, request),
      agentDepth: (context.agentDepth ?? 0) + 1,
      write: Boolean(request.write),
      ownedPaths: request.ownedPaths,
      nonOwnedPaths: request.nonOwnedPaths,
    },
    async (record, handle) => {
      const sink = createParallelAgentProgressSink(scheduler.registry, record.id);
      const runContext: ToolUseContext = {
        ...context,
        abortSignal: handle.abortController.signal,
        supportsBackgroundTasks: false,
        parallelAgentProgress: { taskId: record.id, sink },
      };

      const result = await runtime.run(
        {
          ...request,
          debug: request.debug ?? true,
        },
        runContext,
      );

      const normalized = normalizeParallelAgentResult(result.finalText, result.finalText || result.summary);
      if (result.reason && result.reason !== "completed") {
        throw new Error(result.finalText || result.summary || result.reason);
      }

      return {
        summary: result.summary || normalized.summary,
        finalText: result.finalText,
        structuredResult: normalized.structuredResult,
        usedTools: result.usedTools,
        usage: result.usage,
      };
    },
  );

  completion.catch(() => {
    // Scheduler records failures; avoid unhandled rejections when callers only need the task id.
  });

  return task;
}
