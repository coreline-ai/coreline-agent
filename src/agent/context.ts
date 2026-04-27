/**
 * Agent context — shared state passed through the agent loop.
 */

import type { AskUserQuestionHandler, ReadFileStateStore, TodoStateStore, Tool, ToolUseContext } from "../tools/types.js";
import type { LLMProvider } from "../providers/types.js";
import { PermissionEngine } from "../permissions/engine.js";
import type { PermissionCheckContext, PermissionMode, PermissionRule } from "../permissions/types.js";
import type { ProjectMemoryCore } from "../memory/types.js";
import type { SubAgentRuntime } from "./subagent-types.js";
import type { SubAgentRunRecord } from "../session/records.js";
import type { HookEngine } from "../hooks/index.js";
import type { BackupStoreLike } from "./file-backup.js";
import type { CostTracker } from "./cost-tracker.js";
import type { ToolCache } from "./tool-cache.js";
import type { HardeningHint } from "./hardening-types.js";
import type { ParallelAgentRuntimeCapabilities, ParallelAgentTaskRegistry } from "./parallel/types.js";
import type { ParallelAgentScheduler } from "./parallel/scheduler.js";

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

export interface AppState {
  /** Current working directory */
  cwd: string;

  /** Active LLM provider */
  provider: LLMProvider;

  /** Registered tools (name → Tool) */
  tools: Map<string, Tool>;

  /** Permission engine */
  permissionEngine: PermissionEngine;

  /** Permission context */
  permissionContext: PermissionCheckContext;

  /** Abort controller for the current turn */
  abortController: AbortController;

  /** Total token usage across all turns */
  totalUsage: { inputTokens: number; outputTokens: number };

  /** Optional project memory for AGENT.md / MEMORY integration */
  projectMemory?: ProjectMemoryCore;

  /** Current agent depth (root=0) */
  agentDepth: number;

  /** Non-interactive agents auto-deny permission asks */
  nonInteractive: boolean;

  /** Optional persisted/session id used by stateful tools and tool-result storage. */
  sessionId?: string;

  /** Optional logical agent id used by stateful tools. */
  agentId?: string;

  /** Optional delegated sub-agent runtime capability */
  subAgentRuntime?: SubAgentRuntime;

  /** Optional root-owned background parallel-agent task registry. */
  parallelAgentRegistry?: ParallelAgentTaskRegistry;

  /** Optional scheduler that owns background task execution and queueing. */
  parallelAgentScheduler?: ParallelAgentScheduler;

  /** Runtime capabilities for parallel-agent behavior. */
  parallelAgentCapabilities?: ParallelAgentRuntimeCapabilities;

  /** Optional internal Hook Engine runtime. */
  hookEngine?: HookEngine;

  /** Optional file backup store for write/edit safety and undo. */
  backupStore?: BackupStoreLike;

  /** Optional read-only tool cache shared by safe tools. */
  toolCache?: ToolCache;

  /** Per-session FileRead state for FileEdit read-before-write/stale-write checks. */
  readFileState: ReadFileStateStore;

  /** Optional todo store supplied by the outer runtime. */
  todoStore?: TodoStateStore;

  /** Optional structured-question handler supplied by the interactive runtime. */
  askUserQuestion?: AskUserQuestionHandler;

  /** Short advisory failure hints for future turns. */
  hardeningHints: HardeningHint[];

  /** Optional per-session cost tracker. */
  costTracker?: CostTracker;

  /** Stop the loop when costTracker reports budget exceeded. */
  stopOnBudgetExceeded: boolean;

  /** Optional recorder for persisted sub-agent execution records */
  saveSubAgentRun?: (
    record: Omit<SubAgentRunRecord, "_type" | "sessionId" | "createdAt" | "childId"> & {
      childId?: string;
      id?: string;
      sessionId?: string;
      createdAt?: string;
    },
  ) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppState(opts: {
  cwd: string;
  provider: LLMProvider;
  tools: Tool[];
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRule[];
  projectMemory?: ProjectMemoryCore;
  agentDepth?: number;
  nonInteractive?: boolean;
  sessionId?: string;
  agentId?: string;
  subAgentRuntime?: SubAgentRuntime;
  parallelAgentRegistry?: ParallelAgentTaskRegistry;
  parallelAgentScheduler?: ParallelAgentScheduler;
  parallelAgentCapabilities?: ParallelAgentRuntimeCapabilities;
  hookEngine?: HookEngine;
  backupStore?: BackupStoreLike;
  toolCache?: ToolCache;
  readFileState?: ReadFileStateStore;
  todoStore?: TodoStateStore;
  askUserQuestion?: AskUserQuestionHandler;
  hardeningHints?: HardeningHint[];
  costTracker?: CostTracker;
  stopOnBudgetExceeded?: boolean;
  saveSubAgentRun?: (
    record: Omit<SubAgentRunRecord, "_type" | "sessionId" | "createdAt" | "childId"> & {
      childId?: string;
      id?: string;
      sessionId?: string;
      createdAt?: string;
    },
  ) => void;
}): AppState {
  const toolMap = new Map<string, Tool>();
  for (const tool of opts.tools) {
    toolMap.set(tool.name, tool);
  }

  return {
    cwd: opts.cwd,
    provider: opts.provider,
    tools: toolMap,
    permissionEngine: new PermissionEngine(),
    permissionContext: {
      cwd: opts.cwd,
      mode: opts.permissionMode ?? "default",
      rules: opts.permissionRules ?? [],
    },
    abortController: new AbortController(),
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    projectMemory: opts.projectMemory,
    agentDepth: opts.agentDepth ?? 0,
    nonInteractive: opts.nonInteractive ?? false,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    subAgentRuntime: opts.subAgentRuntime,
    parallelAgentRegistry: opts.parallelAgentRegistry,
    parallelAgentScheduler: opts.parallelAgentScheduler,
    parallelAgentCapabilities: opts.parallelAgentCapabilities,
    hookEngine: opts.hookEngine,
    backupStore: opts.backupStore,
    toolCache: opts.toolCache,
    readFileState: opts.readFileState ?? new Map(),
    todoStore: opts.todoStore,
    askUserQuestion: opts.askUserQuestion,
    hardeningHints: opts.hardeningHints ?? [],
    costTracker: opts.costTracker,
    stopOnBudgetExceeded: opts.stopOnBudgetExceeded ?? false,
    saveSubAgentRun: opts.saveSubAgentRun,
  };
}

// ---------------------------------------------------------------------------
// Derive ToolUseContext from AppState
// ---------------------------------------------------------------------------

export function toToolUseContext(state: AppState): ToolUseContext {
  return {
    cwd: state.cwd,
    abortSignal: state.abortController.signal,
    nonInteractive: state.nonInteractive,
    projectMemory: state.projectMemory,
    permissionContext: state.permissionContext,
    agentDepth: state.agentDepth,
    providerName: state.provider.name,
    providerModel: state.provider.model,
    subAgentRuntime: state.subAgentRuntime,
    parallelAgentRegistry: state.parallelAgentRegistry,
    parallelAgentScheduler: state.parallelAgentScheduler,
    parallelAgentCapabilities: state.parallelAgentCapabilities,
    supportsBackgroundTasks: state.parallelAgentCapabilities?.supportsBackgroundTasks ?? false,
    sessionId: state.sessionId,
    agentId: state.agentId,
    hookEngine: state.hookEngine,
    backupStore: state.backupStore,
    toolCache: state.toolCache,
    readFileState: state.readFileState,
    todoStore: state.todoStore,
    askUserQuestion: state.askUserQuestion,
    saveSubAgentRun: state.saveSubAgentRun,
  };
}
