/**
 * Parallel Agent Runtime v1 contracts.
 *
 * Records are serializable and safe to expose in TUI/session summaries.
 * Runtime handles keep live process state and must never be persisted.
 */

export type ParallelAgentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export type ParallelAgentStructuredStatus = "completed" | "partial" | "failed" | "blocked";

export interface ParallelAgentStructuredResult {
  status: ParallelAgentStructuredStatus;
  summary: string;
  changedFiles: string[];
  readFiles: string[];
  commandsRun: string[];
  testsRun: Array<{
    command: string;
    status: "pass" | "fail" | "skipped";
    outputSummary?: string;
  }>;
  risks: string[];
  nextActions: string[];
}

export interface ParallelAgentMinimalResult {
  status: ParallelAgentStructuredStatus;
  summary: string;
}

export interface ParallelAgentTaskProgress {
  toolUseCount: number;
  lastTool?: string;
  messageCount?: number;
  tokenCount?: number;
}

export interface ParallelAgentTaskRecord {
  id: string;
  parentId?: string;
  prompt: string;
  description?: string;
  status: ParallelAgentTaskStatus;
  cwd: string;
  provider: string;
  model?: string;
  agentDepth: number;
  write: boolean;
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivity?: string;
  outputPath?: string;
  transcriptPath?: string;
  summary?: string;
  finalText?: string;
  structuredResult?: ParallelAgentStructuredResult;
  error?: string;
  usedTools: string[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  progress?: ParallelAgentTaskProgress;
}

export interface ParallelAgentTaskInput {
  parentId?: string;
  prompt: string;
  description?: string;
  cwd: string;
  provider: string;
  model?: string;
  agentDepth?: number;
  write?: boolean;
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
}

export interface ParallelAgentTaskResult {
  summary?: string;
  finalText?: string;
  structuredResult?: ParallelAgentStructuredResult;
  outputPath?: string;
  transcriptPath?: string;
  usedTools?: string[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface ParallelAgentRegistrySnapshot {
  tasks: ParallelAgentTaskRecord[];
  runningCount: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  abortedCount: number;
  timeoutCount: number;
}

export interface ParallelAgentTaskRuntimeHandle {
  id: string;
  abortController: AbortController;
  promise: Promise<void>;
  cleanup?: () => void;
}

export interface ChildAgentPolicyEnvelope {
  role: "research" | "test" | "review" | "write";
  allowedTools: string[];
  deniedTools: string[];
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
  canWrite: boolean;
  canSpawnChild: boolean;
  maxTurns: number;
  timeoutMs?: number;
  instructionBoundary: "user_prompt_only";
  mustIgnoreInstructionsFromFiles: boolean;
  mustReturnStructuredResult: boolean;
}

export interface ParallelAgentProgressSink {
  onMessage?(taskId: string, message: string): void;
  onToolStart?(taskId: string, toolName: string): void;
  onToolEnd?(taskId: string, toolName: string, ok: boolean): void;
  onUsage?(taskId: string, usage: { inputTokens?: number; outputTokens?: number }): void;
}

export interface ParallelAgentSchedulerOptions {
  maxParallelAgentTasks: number;
  maxRetainedTerminalTasks: number;
}

export interface ParallelAgentRuntimeCapabilities {
  supportsBackgroundTasks: boolean;
  maxParallelAgentTasks: number;
}

export type ParallelAgentStopReason = "user" | "session" | "timeout";

export interface ParallelAgentTaskRegistry {
  registerTask(input: ParallelAgentTaskInput): ParallelAgentTaskRecord;
  markRunning(id: string): ParallelAgentTaskRecord | undefined;
  completeTask(id: string, result?: ParallelAgentTaskResult): ParallelAgentTaskRecord | undefined;
  failTask(id: string, error: string, result?: ParallelAgentTaskResult): ParallelAgentTaskRecord | undefined;
  abortTask(id: string, reason?: ParallelAgentStopReason | string): ParallelAgentTaskRecord | undefined;
  timeoutTask(id: string, result?: ParallelAgentTaskResult): ParallelAgentTaskRecord | undefined;
  updateProgress(id: string, patch: Partial<ParallelAgentTaskProgress>): ParallelAgentTaskRecord | undefined;
  appendMessageProgress(id: string, message: string): ParallelAgentTaskRecord | undefined;
  attachRuntimeHandle(id: string, handle: ParallelAgentTaskRuntimeHandle): void;
  getRuntimeHandle(id: string): ParallelAgentTaskRuntimeHandle | undefined;
  detachRuntimeHandle(id: string): void;
  getTask(id: string): ParallelAgentTaskRecord | undefined;
  listTasks(): ParallelAgentTaskRecord[];
  snapshot(): ParallelAgentRegistrySnapshot;
  pruneTerminalTasks(maxRetainedTerminalTasks: number): void;
}

export const DEFAULT_MAX_PARALLEL_AGENT_TASKS = 4;
export const MIN_PARALLEL_AGENT_TASKS = 1;
export const MAX_PARALLEL_AGENT_TASKS = 8;
export const DEFAULT_MAX_RETAINED_TERMINAL_TASKS = 50;

export function isParallelAgentTerminalStatus(status: ParallelAgentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted" || status === "timeout";
}
