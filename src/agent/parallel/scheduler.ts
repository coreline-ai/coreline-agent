import type {
  ParallelAgentRegistrySnapshot,
  ParallelAgentSchedulerOptions,
  ParallelAgentTaskInput,
  ParallelAgentTaskRecord,
  ParallelAgentTaskResult,
  ParallelAgentTaskRuntimeHandle,
  ParallelAgentStopReason,
} from "./types.js";
import { DEFAULT_MAX_PARALLEL_AGENT_TASKS, DEFAULT_MAX_RETAINED_TERMINAL_TASKS } from "./types.js";
import { createParallelAgentTaskRegistry, InMemoryParallelAgentTaskRegistry } from "./task-registry.js";

export type ParallelAgentWork = (
  task: ParallelAgentTaskRecord,
  handle: ParallelAgentTaskRuntimeHandle,
) => Promise<ParallelAgentTaskResult | void> | ParallelAgentTaskResult | void;

interface SchedulerQueueItem {
  id: string;
  work: ParallelAgentWork;
  resolve: (value: ParallelAgentTaskRecord) => void;
  reject: (reason: unknown) => void;
}

interface SchedulerConstructorOptions extends Partial<ParallelAgentSchedulerOptions> {
  registry?: InMemoryParallelAgentTaskRegistry;
  now?: () => Date;
}

function normalizeMaxParallel(value?: number): number {
  if (!Number.isFinite(value ?? NaN)) {
    return DEFAULT_MAX_PARALLEL_AGENT_TASKS;
  }
  return Math.max(1, Math.floor(value ?? DEFAULT_MAX_PARALLEL_AGENT_TASKS));
}

function normalizeMaxRetained(value?: number): number {
  if (!Number.isFinite(value ?? NaN)) {
    return DEFAULT_MAX_RETAINED_TERMINAL_TASKS;
  }
  return Math.max(0, Math.floor(value ?? DEFAULT_MAX_RETAINED_TERMINAL_TASKS));
}

function createNoopHandleCleanup(): () => void {
  return () => {
    // no-op by default
  };
}

export class ParallelAgentScheduler {
  readonly registry: InMemoryParallelAgentTaskRegistry;

  private readonly maxParallelAgentTasks: number;
  private readonly maxRetainedTerminalTasks: number;
  private readonly queue: SchedulerQueueItem[] = [];
  private readonly running = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private draining = false;

  constructor(options: SchedulerConstructorOptions = {}) {
    this.maxParallelAgentTasks = normalizeMaxParallel(options.maxParallelAgentTasks);
    this.maxRetainedTerminalTasks = normalizeMaxRetained(options.maxRetainedTerminalTasks);
    this.registry = options.registry ?? createParallelAgentTaskRegistry({
      maxRetainedTerminalTasks: this.maxRetainedTerminalTasks,
      now: options.now,
    });
  }

  submitTask(input: ParallelAgentTaskInput, work: ParallelAgentWork): {
    task: ParallelAgentTaskRecord;
    completion: Promise<ParallelAgentTaskRecord>;
  } {
    const task = this.registry.registerTask(input);
    const completion = new Promise<ParallelAgentTaskRecord>((resolve, reject) => {
      this.queue.push({ id: task.id, work, resolve, reject });
      void this.pump();
    });
    return { task, completion };
  }

  submit(input: ParallelAgentTaskInput, work: ParallelAgentWork): Promise<ParallelAgentTaskRecord> {
    return this.submitTask(input, work).completion;
  }

  stop(taskId: string, reason: ParallelAgentStopReason | string = "user"): boolean {
    const queuedIndex = this.queue.findIndex((entry) => entry.id === taskId);
    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      if (!entry) {
        return false;
      }
      const aborted = this.registry.abortTask(taskId, reason);
      if (aborted) {
        entry.resolve(aborted);
      } else {
        entry.reject(new Error(`Unable to abort queued task ${taskId}`));
      }
      this.drainTerminalTasks();
      void this.maybeResolveIdle();
      return true;
    }

    const handle = this.registry.getRuntimeHandle(taskId);
    if (!handle) {
      return false;
    }

    handle.abortController.abort();
    const aborted = this.registry.abortTask(taskId, reason);
    this.drainTerminalTasks();
    void this.maybeResolveIdle();
    return Boolean(aborted);
  }

  getTask(taskId: string): ParallelAgentTaskRecord | undefined {
    return this.registry.getTask(taskId);
  }

  snapshot(): ParallelAgentRegistrySnapshot {
    return this.registry.snapshot();
  }

  drainTerminalTasks(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      this.registry.pruneTerminalTasks(this.maxRetainedTerminalTasks);
    } finally {
      this.draining = false;
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private async pump(): Promise<void> {
    while (this.running.size < this.maxParallelAgentTasks && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      const task = this.registry.getTask(next.id);
      if (!task) {
        next.reject(new Error(`Missing task ${next.id}`));
        continue;
      }

      const handle: ParallelAgentTaskRuntimeHandle = {
        id: next.id,
        abortController: new AbortController(),
        promise: Promise.resolve(),
        cleanup: createNoopHandleCleanup(),
      };

      this.registry.attachRuntimeHandle(next.id, handle);
      this.registry.markRunning(next.id);
      this.running.add(next.id);

      const settled = Promise.resolve()
        .then(() => next.work(this.registry.getTask(next.id) ?? task, handle))
        .then((result) => {
          if (handle.abortController.signal.aborted) {
            const aborted = this.registry.abortTask(next.id, "user");
            if (aborted) {
              next.resolve(aborted);
              return;
            }
          }

          const finalRecord = result
            ? this.registry.completeTask(next.id, result)
            : this.registry.completeTask(next.id);
          if (finalRecord) {
            next.resolve(finalRecord);
          } else {
            next.resolve(this.registry.getTask(next.id) ?? task);
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const finalRecord = this.registry.failTask(next.id, message);
          if (finalRecord) {
            next.resolve(finalRecord);
          } else {
            next.reject(error);
          }
        })
        .finally(() => {
          this.running.delete(next.id);
          this.registry.detachRuntimeHandle(next.id);
          this.drainTerminalTasks();
          void this.pump();
          void this.maybeResolveIdle();
        });

      handle.promise = settled.then(() => undefined, () => undefined);
    }
  }

  private async maybeResolveIdle(): Promise<void> {
    if (this.queue.length > 0 || this.running.size > 0) {
      return;
    }
    while (this.idleWaiters.length > 0) {
      const resolve = this.idleWaiters.shift();
      resolve?.();
    }
  }
}
