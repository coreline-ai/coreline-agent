/**
 * Tool system types + buildTool() factory.
 *
 * Design reference: Claude Code's Tool.ts buildTool() pattern.
 * - Each tool is defined as a plain object matching ToolDef
 * - buildTool() spreads safe defaults, then the user definition
 * - Zod schemas validate input at runtime and generate JSON Schema for LLMs
 */

import type { z, ZodType } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import type { ProjectMemoryCore, GlobalUserMemoryCore } from "../memory/types.js";
import type { PermissionCheckContext } from "../permissions/types.js";
import type { SubAgentRuntime } from "../agent/subagent-types.js";
import type { SubAgentRunRecord } from "../session/records.js";
import type { HookEngine } from "../hooks/index.js";
import type { BackupStoreLike } from "../agent/file-backup.js";
import type { ToolCache } from "../agent/tool-cache.js";
import type { ParallelAgentProgressSink, ParallelAgentRuntimeCapabilities, ParallelAgentTaskRegistry } from "../agent/parallel/types.js";
import type { ParallelAgentScheduler } from "../agent/parallel/scheduler.js";

// ---------------------------------------------------------------------------
// Permission Result (simplified from Claude Code's PermissionResult)
// ---------------------------------------------------------------------------

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionResult {
  behavior: PermissionBehavior;
  reason?: string;
}

// ---------------------------------------------------------------------------
// File Read State (FileRead → FileEdit stale-write guard)
// ---------------------------------------------------------------------------

export interface ReadFileStateEntry {
  /** Absolute resolved path used by FileRead/FileEdit. */
  filePath: string;

  /** Raw decoded file content captured by FileRead. */
  content: string;

  /** File mtime at the time of the read. */
  mtimeMs: number;

  /** Requested FileRead line offset. */
  offset: number;

  /** Requested FileRead line limit. */
  limit: number;

  /** True when FileRead returned only a partial/non-editable view. */
  isPartialView: boolean;
}

export type ReadFileStateStore = Map<string, ReadFileStateEntry>;

// ---------------------------------------------------------------------------
// Lightweight per-session tool state / user input contracts
// ---------------------------------------------------------------------------

export interface TodoStateStore<TTodo = unknown> {
  get(key: string): readonly TTodo[] | undefined;
  set(key: string, todos: readonly TTodo[]): void;
  clear(key: string): void;
}

export interface AskUserQuestionRequest {
  questions: Array<{
    question: string;
    options: Array<{
      label: string;
      description?: string;
    }>;
  }>;
}

export interface AskUserQuestionResponse {
  answers: Array<{
    questionIndex: number;
    selectedLabel?: string;
    optionIndex?: number;
  }>;
  cancelled?: boolean;
}

export type AskUserQuestionHandler = (
  request: AskUserQuestionRequest,
) => Promise<AskUserQuestionResponse> | AskUserQuestionResponse;

// ---------------------------------------------------------------------------
// Tool Use Context (passed to every tool.call())
// ---------------------------------------------------------------------------

export interface ToolUseContext {
  /** Current working directory */
  cwd: string;

  /** Abort signal for cancellation */
  abortSignal: AbortSignal;

  /** Whether the agent is running in non-interactive mode */
  nonInteractive: boolean;

  /** Optional project-scoped memory store */
  projectMemory?: ProjectMemoryCore;

  /** Optional global user memory store (v2, lower priority than project memory) */
  globalMemory?: GlobalUserMemoryCore;

  /** Permission context active for the current agent */
  permissionContext?: PermissionCheckContext;

  /** Current agent depth (root=0, child=1) */
  agentDepth?: number;

  /** Optional sub-agent runtime capability */
  subAgentRuntime?: SubAgentRuntime;

  /** Optional active provider name for task records and diagnostics. */
  providerName?: string;

  /** Optional active provider model for task records and diagnostics. */
  providerModel?: string;

  /** Optional background parallel-agent task registry for root TUI sessions. */
  parallelAgentRegistry?: ParallelAgentTaskRegistry;

  /** Optional scheduler that owns background task execution and queueing. */
  parallelAgentScheduler?: ParallelAgentScheduler;

  /** Runtime capabilities for parallel-agent behavior in this execution context. */
  parallelAgentCapabilities?: ParallelAgentRuntimeCapabilities;

  /** Convenience flag: true only when this context can keep background tasks alive after tool return. */
  supportsBackgroundTasks?: boolean;

  /** Optional progress sink used by background child execution. */
  parallelAgentProgress?: { taskId: string; sink: ParallelAgentProgressSink };

  /** Optional persisted/session id for stateful tools and tool-result storage. */
  sessionId?: string;

  /** Optional logical agent id for stateful tools. */
  agentId?: string;

  /** Optional internal Hook Engine runtime for PreTool hooks. */
  hookEngine?: HookEngine;

  /** Optional file backup store for write/edit safety and undo. */
  backupStore?: BackupStoreLike;

  /** Optional read-only tool cache for FileRead/Glob and future safe tools. */
  toolCache?: ToolCache;

  /**
   * Per-session FileRead state used by FileEdit to enforce read-before-write
   * and prevent stale writes. AppState always initializes this; optional keeps
   * low-level tool tests/back-compat contexts possible.
   */
  readFileState?: ReadFileStateStore;

  /** Optional explicit todo state key supplied by the agent loop/session layer. */
  todoStateKey?: string;

  /** Optional todo store supplied by the agent loop/session layer. */
  todoStore?: TodoStateStore;

  /** Optional interactive structured-question handler used by AskUserQuestion. */
  askUserQuestion?: AskUserQuestionHandler;

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
// Tool Result
// ---------------------------------------------------------------------------

export interface ToolResult<T = unknown> {
  data: T;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Interface
// ---------------------------------------------------------------------------

export interface Tool<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> {
  /** Unique tool name (sent to LLM) */
  readonly name: string;

  /** Human-readable description (sent to LLM) */
  readonly description: string;

  /** Zod schema for input validation */
  readonly inputSchema: ZodType<Input>;

  /** Execute the tool */
  call(input: Input, context: ToolUseContext): Promise<ToolResult<Output>>;

  /** Check if this tool use requires permission */
  checkPermissions(input: Input, context: ToolUseContext): PermissionResult;

  /** Is this tool read-only? (affects concurrency decisions) */
  isReadOnly(input: Input): boolean;

  /** Can this tool run concurrently with others? */
  isConcurrencySafe(input: Input): boolean;

  /** Format tool output as a string for the LLM */
  formatResult(output: Output, toolUseId: string): string;

  /** Max result size in characters (truncate beyond this) */
  readonly maxResultSizeChars: number;
}

// ---------------------------------------------------------------------------
// Tool Definition (partial — used with buildTool())
// ---------------------------------------------------------------------------

export type ToolDef<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> = {
  name: string;
  description: string;
  inputSchema: ZodType<Input>;
  call(input: Input, context: ToolUseContext): Promise<ToolResult<Output>>;
  formatResult(output: Output, toolUseId: string): string;

  // Optional overrides (buildTool provides defaults)
  checkPermissions?: (input: Input, context: ToolUseContext) => PermissionResult;
  isReadOnly?: (input: Input) => boolean;
  isConcurrencySafe?: (input: Input) => boolean;
  maxResultSizeChars?: number;
};

// ---------------------------------------------------------------------------
// buildTool() Factory
// ---------------------------------------------------------------------------

const TOOL_DEFAULTS = {
  checkPermissions: (): PermissionResult => ({ behavior: "allow" }),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 100_000,
} as const;

/**
 * Build a Tool from a partial definition, filling in safe defaults.
 *
 * Usage:
 * ```ts
 * export const MyTool = buildTool({
 *   name: "MyTool",
 *   description: "Does something",
 *   inputSchema: z.object({ path: z.string() }),
 *   async call(input, ctx) { ... },
 *   formatResult(output, id) { ... },
 * });
 * ```
 */
export function buildTool<
  Input extends Record<string, unknown>,
  Output,
>(def: ToolDef<Input, Output>): Tool<Input, Output> {
  return {
    ...TOOL_DEFAULTS,
    ...def,
  } as Tool<Input, Output>;
}

// ---------------------------------------------------------------------------
// Tool → ToolDefinition (for LLM API)
// ---------------------------------------------------------------------------

/**
 * Convert a Tool's Zod schema to a JSON Schema ToolDefinition
 * for sending to the LLM provider.
 */
export async function toolToDefinition(tool: Tool): Promise<ToolDefinition> {
  const { zodToJsonSchema } = await import("zod-to-json-schema");

  const jsonSchema = zodToJsonSchema(tool.inputSchema, {
    $refStrategy: "none",
    target: "openApi3",
  });

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchema as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Tool Registry Interface
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  /** Register a tool */
  register(tool: Tool): void;

  /** Get tool by name */
  getByName(name: string): Tool | undefined;

  /** Get all registered tools */
  getAll(): Tool[];

  /** Get tool definitions for LLM API */
  getToolDefinitions(): Promise<ToolDefinition[]>;
}
