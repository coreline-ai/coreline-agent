import type { ParallelAgentProgressSink, ParallelAgentTaskProgress } from "./types.js";
import type { InMemoryParallelAgentTaskRegistry } from "./task-registry.js";

function normalizeTokenCount(value?: { inputTokens?: number; outputTokens?: number }): number | undefined {
  if (!value) {
    return undefined;
  }
  const inputTokens = Number.isFinite(value.inputTokens ?? NaN) ? Number(value.inputTokens ?? 0) : 0;
  const outputTokens = Number.isFinite(value.outputTokens ?? NaN) ? Number(value.outputTokens ?? 0) : 0;
  return inputTokens + outputTokens;
}

function mergeProgressPatch(
  current: Partial<ParallelAgentTaskProgress> | undefined,
  patch: Partial<ParallelAgentTaskProgress>,
): Partial<ParallelAgentTaskProgress> {
  return {
    ...(current ?? {}),
    ...patch,
  };
}

export function createParallelAgentProgressSink(
  registry: InMemoryParallelAgentTaskRegistry,
  taskId: string,
): ParallelAgentProgressSink {
  return {
    onMessage(_taskId, _message) {
      const current = registry.getTask(taskId);
      const progress = current?.progress ?? { toolUseCount: 0, messageCount: 0, tokenCount: 0 };
      registry.updateProgress(taskId, mergeProgressPatch(progress, {
        messageCount: (progress.messageCount ?? 0) + 1,
      }));
    },
    onToolStart(_taskId, toolName) {
      const current = registry.getTask(taskId);
      const progress = current?.progress ?? { toolUseCount: 0, messageCount: 0, tokenCount: 0 };
      registry.updateProgress(taskId, mergeProgressPatch(progress, {
        toolUseCount: (progress.toolUseCount ?? 0) + 1,
        lastTool: toolName,
      }));
    },
    onToolEnd(_taskId, toolName) {
      const current = registry.getTask(taskId);
      const progress = current?.progress ?? { toolUseCount: 0, messageCount: 0, tokenCount: 0 };
      registry.updateProgress(taskId, mergeProgressPatch(progress, {
        lastTool: toolName,
      }));
    },
    onUsage(_taskId, usage) {
      const current = registry.getTask(taskId);
      const progress = current?.progress ?? { toolUseCount: 0, messageCount: 0, tokenCount: 0 };
      const tokenCount = normalizeTokenCount(usage);
      registry.updateProgress(taskId, mergeProgressPatch(progress, {
        tokenCount: (progress.tokenCount ?? 0) + (tokenCount ?? 0),
      }));
    },
  };
}

export function updateParallelAgentProgress(
  registry: InMemoryParallelAgentTaskRegistry,
  taskId: string,
  patch: Partial<ParallelAgentTaskProgress>,
): void {
  registry.updateProgress(taskId, patch);
}
