import type {
  ParallelAgentRegistrySnapshot,
  ParallelAgentTaskInput,
  ParallelAgentTaskProgress,
  ParallelAgentTaskRecord,
  ParallelAgentTaskRegistry,
  ParallelAgentTaskResult,
  ParallelAgentTaskRuntimeHandle,
  ParallelAgentTaskStatus,
  ParallelAgentStopReason,
} from "./types.js";
import { DEFAULT_MAX_RETAINED_TERMINAL_TASKS, isParallelAgentTerminalStatus } from "./types.js";

type NowFn = () => Date;

interface RegistryOptions {
  now?: NowFn;
  maxRetainedTerminalTasks?: number;
}

interface InternalTaskMeta {
  sequence: number;
}

function nowIso(now: NowFn): string {
  return now().toISOString();
}

function cloneTask<T>(task: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(task);
  }
  return JSON.parse(JSON.stringify(task)) as T;
}

function normalizeRetainedLimit(limit?: number): number {
  if (!Number.isFinite(limit ?? NaN)) {
    return DEFAULT_MAX_RETAINED_TERMINAL_TASKS;
  }
  return Math.max(0, Math.floor(limit ?? DEFAULT_MAX_RETAINED_TERMINAL_TASKS));
}

function createEmptyProgress(): ParallelAgentTaskProgress {
  return {
    toolUseCount: 0,
    messageCount: 0,
    tokenCount: 0,
  };
}

function defaultSummary(record: ParallelAgentTaskRecord): string {
  if (record.summary) {
    return record.summary;
  }
  if (record.finalText) {
    return record.finalText;
  }
  if (record.error) {
    return record.error;
  }
  return record.prompt;
}

function mergeUsage(
  base: ParallelAgentTaskRecord["usage"],
  next?: ParallelAgentTaskResult["usage"],
): ParallelAgentTaskRecord["usage"] {
  if (!next) {
    return base;
  }
  return {
    inputTokens: next.inputTokens ?? base?.inputTokens ?? 0,
    outputTokens: next.outputTokens ?? base?.outputTokens ?? 0,
    totalTokens: next.totalTokens ?? ((next.inputTokens ?? 0) + (next.outputTokens ?? 0)),
  };
}

function normalizeTaskStatus(status: ParallelAgentTaskStatus): ParallelAgentTaskStatus {
  return status;
}

export class InMemoryParallelAgentTaskRegistry implements ParallelAgentTaskRegistry {
  private readonly now: NowFn;
  private readonly maxRetainedTerminalTasks: number;
  private readonly tasks = new Map<string, ParallelAgentTaskRecord>();
  private readonly handles = new Map<string, ParallelAgentTaskRuntimeHandle>();
  private readonly terminalOrder: string[] = [];
  private readonly meta = new Map<string, InternalTaskMeta>();
  private nextId = 1;

  constructor(options: RegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxRetainedTerminalTasks = normalizeRetainedLimit(options.maxRetainedTerminalTasks);
  }

  registerTask(input: ParallelAgentTaskInput): ParallelAgentTaskRecord {
    const id = this.nextTaskId();
    const timestamp = nowIso(this.now);
    const record: ParallelAgentTaskRecord = {
      id,
      parentId: input.parentId,
      prompt: input.prompt,
      description: input.description,
      status: "pending",
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      agentDepth: input.agentDepth ?? 0,
      write: input.write ?? false,
      ownedPaths: input.ownedPaths,
      nonOwnedPaths: input.nonOwnedPaths,
      createdAt: timestamp,
      updatedAt: timestamp,
      usedTools: [],
      progress: createEmptyProgress(),
    };

    this.tasks.set(id, record);
    this.meta.set(id, { sequence: this.nextId++ });
    return cloneTask(record);
  }

  markRunning(id: string): ParallelAgentTaskRecord | undefined {
    return this.transitionTask(id, "running", (record, timestamp) => {
      if (!record.startedAt) {
        record.startedAt = timestamp;
      }
      record.lastActivity = timestamp;
    });
  }

  completeTask(id: string, result?: ParallelAgentTaskResult): ParallelAgentTaskRecord | undefined {
    return this.finishTask(id, "completed", result);
  }

  failTask(id: string, error: string, result?: ParallelAgentTaskResult): ParallelAgentTaskRecord | undefined {
    return this.finishTask(id, "failed", result, error);
  }

  abortTask(id: string, reason?: ParallelAgentStopReason | string): ParallelAgentTaskRecord | undefined {
    return this.finishTask(id, "aborted", undefined, reason ? `Aborted${reason ? `: ${reason}` : ""}` : "Aborted");
  }

  timeoutTask(id: string, result?: ParallelAgentTaskResult): ParallelAgentTaskRecord | undefined {
    return this.finishTask(id, "timeout", result, "Timed out");
  }

  updateProgress(id: string, patch: Partial<ParallelAgentTaskProgress>): ParallelAgentTaskRecord | undefined {
    return this.transitionTask(id, undefined, (record, timestamp) => {
      record.progress = {
        ...createEmptyProgress(),
        ...(record.progress ?? {}),
        ...patch,
      };
      record.updatedAt = timestamp;
      record.lastActivity = timestamp;
    });
  }

  appendMessageProgress(id: string, message: string): ParallelAgentTaskRecord | undefined {
    return this.transitionTask(id, undefined, (record, timestamp) => {
      const progress = record.progress ?? createEmptyProgress();
      record.progress = {
        ...progress,
        messageCount: (progress.messageCount ?? 0) + 1,
      };
      record.updatedAt = timestamp;
      record.lastActivity = timestamp;
      if (!record.summary && message.trim()) {
        record.summary = message.trim();
      }
    });
  }

  attachRuntimeHandle(id: string, handle: ParallelAgentTaskRuntimeHandle): void {
    const current = this.handles.get(id);
    if (current && current !== handle) {
      this.safeCleanup(current);
    }
    this.handles.set(id, handle);
  }

  getRuntimeHandle(id: string): ParallelAgentTaskRuntimeHandle | undefined {
    return this.handles.get(id);
  }

  detachRuntimeHandle(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) {
      return;
    }
    this.safeCleanup(handle);
    this.handles.delete(id);
  }

  getTask(id: string): ParallelAgentTaskRecord | undefined {
    const record = this.tasks.get(id);
    return record ? cloneTask(record) : undefined;
  }

  listTasks(): ParallelAgentTaskRecord[] {
    return this.sortedTasks().map((record) => cloneTask(record));
  }

  snapshot(): ParallelAgentRegistrySnapshot {
    const tasks = this.sortedTasks();
    let runningCount = 0;
    let pendingCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let abortedCount = 0;
    let timeoutCount = 0;

    for (const task of tasks) {
      switch (normalizeTaskStatus(task.status)) {
        case "pending":
          pendingCount++;
          break;
        case "running":
          runningCount++;
          break;
        case "completed":
          completedCount++;
          break;
        case "failed":
          failedCount++;
          break;
        case "aborted":
          abortedCount++;
          break;
        case "timeout":
          timeoutCount++;
          break;
      }
    }

    return {
      tasks: tasks.map((record) => cloneTask(record)),
      runningCount,
      pendingCount,
      completedCount,
      failedCount,
      abortedCount,
      timeoutCount,
    };
  }

  pruneTerminalTasks(maxRetainedTerminalTasks: number): void {
    const limit = normalizeRetainedLimit(maxRetainedTerminalTasks);
    if (limit === 0) {
      for (const id of this.terminalOrder.splice(0)) {
        this.deleteTask(id);
      }
      return;
    }

    const terminalRecords = this.terminalOrder
      .map((id) => this.tasks.get(id))
      .filter((record): record is ParallelAgentTaskRecord => record !== undefined)
      .filter((record) => isParallelAgentTerminalStatus(record.status));

    if (terminalRecords.length <= limit) {
      return;
    }

    const removable = terminalRecords
      .slice(0, terminalRecords.length - limit)
      .map((record) => record.id);

    for (const id of removable) {
      this.deleteTask(id);
    }
  }

  private finishTask(
    id: string,
    status: Exclude<ParallelAgentTaskStatus, "pending" | "running">,
    result?: ParallelAgentTaskResult,
    error?: string,
  ): ParallelAgentTaskRecord | undefined {
    return this.transitionTask(id, status, (record, timestamp) => {
      record.status = status;
      record.updatedAt = timestamp;
      record.finishedAt = timestamp;
      record.lastActivity = timestamp;
      record.summary = result?.summary ?? record.summary ?? (status === "failed" || status === "aborted" || status === "timeout" ? error ?? defaultSummary(record) : defaultSummary(record));
      record.finalText = result?.finalText ?? record.finalText ?? result?.summary ?? record.summary ?? defaultSummary(record);
      record.structuredResult = result?.structuredResult ?? record.structuredResult;
      record.outputPath = result?.outputPath ?? record.outputPath;
      record.transcriptPath = result?.transcriptPath ?? record.transcriptPath;
      record.usedTools = result?.usedTools ?? record.usedTools;
      record.usage = mergeUsage(record.usage, result?.usage);
      if (error) {
        record.error = error;
      }
      if (!record.progress) {
        record.progress = createEmptyProgress();
      }
    });
  }

  private transitionTask(
    id: string,
    nextStatus: ParallelAgentTaskStatus | undefined,
    mutator: (record: ParallelAgentTaskRecord, timestamp: string) => void,
  ): ParallelAgentTaskRecord | undefined {
    const record = this.tasks.get(id);
    if (!record) {
      return undefined;
    }

    if (isParallelAgentTerminalStatus(record.status)) {
      return cloneTask(record);
    }

    if (nextStatus === "running") {
      if (record.status !== "pending") {
        return cloneTask(record);
      }
    } else if (nextStatus && !isParallelAgentTerminalStatus(nextStatus)) {
      return cloneTask(record);
    }

    const timestamp = nowIso(this.now);
    mutator(record, timestamp);
    if (nextStatus) {
      record.status = nextStatus;
    }
    record.updatedAt = timestamp;

    if (nextStatus && isParallelAgentTerminalStatus(nextStatus)) {
      this.markTerminal(id);
      this.cleanupRuntimeHandle(id);
      this.pruneTerminalTasks(this.maxRetainedTerminalTasks);
    }

    return cloneTask(record);
  }

  private cleanupRuntimeHandle(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) {
      return;
    }
    this.safeCleanup(handle);
    this.handles.delete(id);
  }

  private safeCleanup(handle: ParallelAgentTaskRuntimeHandle): void {
    try {
      handle.cleanup?.();
    } catch {
      // Cleanup is best effort only.
    }
  }

  private markTerminal(id: string): void {
    if (!this.terminalOrder.includes(id)) {
      this.terminalOrder.push(id);
    }
  }

  private sortedTasks(): ParallelAgentTaskRecord[] {
    return [...this.tasks.values()].sort((left, right) => {
      const leftMeta = this.meta.get(left.id)?.sequence ?? 0;
      const rightMeta = this.meta.get(right.id)?.sequence ?? 0;
      if (leftMeta !== rightMeta) {
        return leftMeta - rightMeta;
      }
      return left.id.localeCompare(right.id);
    });
  }

  private deleteTask(id: string): void {
    this.cleanupRuntimeHandle(id);
    this.tasks.delete(id);
    this.meta.delete(id);
    const index = this.terminalOrder.indexOf(id);
    if (index >= 0) {
      this.terminalOrder.splice(index, 1);
    }
  }

  private nextTaskId(): string {
    const seq = String(this.nextId).padStart(4, "0");
    return `parallel-task-${seq}`;
  }
}

export function createParallelAgentTaskRegistry(options: RegistryOptions = {}): InMemoryParallelAgentTaskRegistry {
  return new InMemoryParallelAgentTaskRegistry(options);
}
