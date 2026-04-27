/**
 * Default sub-agent runtime for AgentTool MVP/v2.
 *
 * Goals:
 * - reuse the same provider instance by default
 * - filter child tools to a constrained subset
 * - cap depth and maxTurns
 * - support parallel child batches with bounded fan-out
 * - keep the parent result compact while optionally exposing debug records
 */

import type { LLMProvider } from "../providers/types.js";
import type { ChatMessage, AssistantMessage, Usage, TurnEndReason, AgentEvent, UserMessage } from "./types.js";
import { createAppState } from "./context.js";
import { agentLoop } from "./loop.js";
import { buildSubAgentSystemPrompt } from "./system-prompt.js";
import type { Tool, ToolUseContext } from "../tools/types.js";
import {
  SUB_AGENT_DEFAULT_CHILDREN,
  SUB_AGENT_DEFAULT_MAX_TURNS,
  SUB_AGENT_DEFAULT_TOOL_ALLOWLIST,
  SUB_AGENT_DEPTH2_DEFAULT_MAX_TURNS,
  SUB_AGENT_DEPTH2_DEFAULT_TIMEOUT_MS,
  SUB_AGENT_DEPTH2_MAX_TIMEOUT_MS,
  SUB_AGENT_DEPTH2_MAX_TURNS,
  SUB_AGENT_MAX_DEPTH,
  SUB_AGENT_MAX_TURNS,
  SUB_AGENT_WRITE_TOOL_ALLOWLIST,
} from "./subagent-types.js";
import type {
  SubAgentArtifact,
  SubAgentChildResult,
  SubAgentChildStatus,
  SubAgentDebugRecord,
  SubAgentFailure,
  SubAgentProviderResolver,
  SubAgentRequest,
  SubAgentResult,
  SubAgentRuntime,
  SubAgentTaskRequest,
} from "./subagent-types.js";
import { runPipeline } from "./pipeline-runner.js";
import type { PipelineStageExecResult } from "./pipeline-runner.js";
import type { PipelineStage } from "./pipeline-types.js";

const MAX_SUMMARY_CHARS = 240;
const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const READ_ONLY_CHILD_TOOLS = new Set<string>(SUB_AGENT_DEFAULT_TOOL_ALLOWLIST as readonly string[]);
const WRITE_CHILD_TOOLS = new Set<string>(SUB_AGENT_WRITE_TOOL_ALLOWLIST as readonly string[]);

type AbortCause = "aborted" | "timeout";

interface ScopedAbortHandle {
  signal: AbortSignal;
  cleanup: () => void;
  cause: () => AbortCause | null;
}

interface ChildExecutionOptions {
  id: string;
  parentDebug: boolean;
  parentAbortCause?: () => AbortCause | null;
  extraAbortSignals?: AbortSignal[];
}

export interface DefaultSubAgentRuntimeOptions {
  provider: LLMProvider;
  tools: Tool[];
  providerResolver?: SubAgentProviderResolver;
  onDebugRecord?: (record: SubAgentDebugRecord) => void;
  maxConcurrentChildren?: number;
}

interface CollectedLoopResult {
  events: AgentEvent[];
  returnValue: { reason: TurnEndReason };
}

interface ResolvedTaskRequest extends SubAgentTaskRequest {
  id: string;
}

function normalizeSummaryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateSummary(text: string): string {
  const normalized = normalizeSummaryText(text);
  if (!normalized) {
    return "(no final text)";
  }

  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function extractAssistantText(message: ChatMessage): string {
  if (message.role !== "assistant") {
    return "";
  }

  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function toUsage(total: { inputTokens: number; outputTokens: number }): Usage {
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    totalTokens: total.inputTokens + total.outputTokens,
  };
}

function isAllowedChildTool(
  tool: Tool,
  requested: Set<string> | null,
  allowWriteTools: boolean,
  allowAgentTool: boolean,
): boolean {
  if (tool.name === "Agent") {
    if (!allowAgentTool) {
      return false;
    }
  } else if (WRITE_CHILD_TOOLS.has(tool.name)) {
    if (!allowWriteTools) {
      return false;
    }
  } else if (!READ_ONLY_CHILD_TOOLS.has(tool.name)) {
    return false;
  }

  if (requested && !requested.has(tool.name)) {
    return false;
  }

  return true;
}

function buildChildTools(
  tools: Tool[],
  requestedAllowedTools?: string[],
  options?: { allowWriteTools?: boolean; allowAgentTool?: boolean },
): Tool[] {
  const requested = requestedAllowedTools ? new Set(requestedAllowedTools) : null;
  const seen = new Set<string>();
  const result: Tool[] = [];
  const allowWriteTools = options?.allowWriteTools ?? false;
  const allowAgentTool = options?.allowAgentTool ?? false;

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }

    if (!isAllowedChildTool(tool, requested, allowWriteTools, allowAgentTool)) {
      continue;
    }

    seen.add(tool.name);
    result.push(tool);
  }

  return result;
}

function createScopedAbortHandle(parentSignals: AbortSignal[], timeoutMs?: number): ScopedAbortHandle {
  const controller = new AbortController();
  let cause: AbortCause | null = null;
  const cleanupFns: Array<() => void> = [];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abort = (nextCause: AbortCause) => {
    if (cause) {
      return;
    }

    cause = nextCause;
    controller.abort();
  };

  for (const signal of parentSignals) {
    if (signal.aborted) {
      abort("aborted");
      continue;
    }

    const listener = () => abort("aborted");
    signal.addEventListener("abort", listener, { once: true });
    cleanupFns.push(() => signal.removeEventListener("abort", listener));
  }

  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    timeoutId = setTimeout(() => abort("timeout"), timeoutMs);
  }

  return {
    signal: controller.signal,
    cause: () => cause,
    cleanup: () => {
      for (const cleanup of cleanupFns) {
        cleanup();
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}

function resolveAbortCause(
  localCause: AbortCause | null,
  parentCause: AbortCause | null,
): AbortCause | null {
  if (localCause === "timeout" || parentCause === "timeout") {
    return "timeout";
  }

  if (localCause === "aborted" || parentCause === "aborted") {
    return "aborted";
  }

  return null;
}

function createDeniedResult(reason: string): SubAgentResult {
  return {
    finalText: reason,
    summary: reason,
    turns: 0,
    usedTools: [],
    usage: EMPTY_USAGE,
    reason: "depth_limit",
    artifacts: buildCommonArtifacts({
      summary: reason,
      finalText: reason,
      usedTools: [],
      status: "denied",
      turns: 0,
    }),
  };
}

function createChildFailureResult(params: {
  id: string;
  prompt: string;
  status: Exclude<SubAgentChildStatus, "completed">;
  provider: LLMProvider;
  write: boolean;
  reason: string;
  message: string;
  model?: string;
  debug?: SubAgentDebugRecord;
}): SubAgentChildResult {
  const summary = truncateSummary(params.message);
  return {
    id: params.id,
    prompt: params.prompt,
    status: params.status,
    provider: params.provider.name,
    model: params.model ?? params.provider.model,
    write: params.write,
    finalText: params.message,
    summary,
    turns: 0,
    usedTools: [],
    usage: EMPTY_USAGE,
    reason: params.reason,
    error: params.message,
    debug: params.debug,
    artifacts: buildChildArtifacts({
      status: params.status,
      summary,
      finalText: params.message,
      usedTools: [],
      turns: 0,
      error: params.message,
    }),
  };
}

function createSkippedChildFailureResult(params: {
  id: string;
  prompt: string;
  status: Exclude<SubAgentChildStatus, "completed">;
  provider: LLMProvider;
  write: boolean;
  reason: string;
  message: string;
  model?: string;
  debug?: SubAgentDebugRecord;
}): SubAgentChildResult {
  return createChildFailureResult(params);
}

function createEmptyResult(reason: TurnEndReason | string, finalText = ""): SubAgentResult {
  const summary = truncateSummary(finalText || reason);
  return {
    finalText,
    summary,
    turns: 0,
    usedTools: [],
    usage: EMPTY_USAGE,
    reason,
    artifacts: buildCommonArtifacts({
      summary,
      finalText,
      usedTools: [],
      status: reason,
      turns: 0,
    }),
  };
}

function makeDebugRequest(request: SubAgentTaskRequest, subtasks?: number): SubAgentDebugRecord["request"] {
  return {
    prompt: request.prompt,
    allowedTools: request.allowedTools,
    ownedPaths: request.ownedPaths,
    nonOwnedPaths: request.nonOwnedPaths,
    contracts: request.contracts,
    mergeNotes: request.mergeNotes,
    maxTurns: request.maxTurns,
    timeoutMs: request.timeoutMs,
    provider: request.provider,
    model: request.model,
    write: request.write,
    debug: request.debug,
    subtasks,
  };
}

function providerInfo(provider: LLMProvider): SubAgentDebugRecord["provider"] {
  return {
    name: provider.name,
    type: provider.type,
    model: provider.model,
  };
}

function uniqueToolNames(results: SubAgentChildResult[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const child of results) {
    for (const toolName of child.usedTools) {
      if (seen.has(toolName)) {
        continue;
      }
      seen.add(toolName);
      ordered.push(toolName);
    }
  }

  return ordered;
}

function buildCommonArtifacts(params: {
  summary: string;
  finalText: string;
  usedTools: string[];
  status: string;
  turns: number;
}): SubAgentArtifact[] {
  return [
    { kind: "status", label: "status", value: params.status },
    { kind: "summary", label: "summary", value: params.summary || "(no summary)" },
    { kind: "final_text", label: "final text", value: params.finalText || "(no final text)" },
    {
      kind: "tools",
      label: "used tools",
      value: params.usedTools.length > 0 ? params.usedTools.join(", ") : "(none)",
    },
    { kind: "status", label: "turns", value: String(params.turns) },
  ];
}

function buildChildArtifacts(
  child: Pick<SubAgentChildResult, "status" | "summary" | "finalText" | "usedTools" | "turns" | "error">,
): SubAgentArtifact[] {
  const artifacts = buildCommonArtifacts({
    summary: child.summary,
    finalText: child.finalText,
    usedTools: child.usedTools,
    status: child.status,
    turns: child.turns,
  });

  if (child.error) {
    artifacts.push({ kind: "failure", label: "error", value: child.error });
  }

  return artifacts;
}

function buildCoordinatorArtifacts(params: {
  partial: boolean;
  childCount: number;
  completedCount: number;
  failedCount: number;
  summary: string;
  finalText: string;
  usedTools: string[];
  turns: number;
}): SubAgentArtifact[] {
  return [
    { kind: "status", label: "mode", value: "coordinator" },
    { kind: "status", label: "status", value: params.partial ? "partial" : "completed" },
    { kind: "status", label: "children", value: String(params.childCount) },
    { kind: "status", label: "completed", value: String(params.completedCount) },
    { kind: "status", label: "failed", value: String(params.failedCount) },
    ...buildCommonArtifacts({
      summary: params.summary,
      finalText: params.finalText,
      usedTools: params.usedTools,
      status: params.partial ? "partial" : "completed",
      turns: params.turns,
    }),
  ];
}

function sumUsage(results: SubAgentChildResult[]): Usage {
  const aggregate = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const child of results) {
    aggregate.inputTokens += child.usage.inputTokens;
    aggregate.outputTokens += child.usage.outputTokens;
    aggregate.totalTokens += child.usage.totalTokens;
  }
  return aggregate;
}

function formatFailureLine(failure: SubAgentFailure): string {
  return `[${failure.status}] ${failure.id}: ${failure.prompt} — ${failure.message}`;
}

function buildCoordinatorFinalText(
  requestPrompt: string,
  children: SubAgentChildResult[],
  failures: SubAgentFailure[],
): string {
  const completedCount = children.filter((child) => child.status === "completed").length;
  const failedCount = children.length - completedCount;
  const usedTools = uniqueToolNames(children);
  const lines = [
    "COORDINATOR_RESULT",
    `request: ${requestPrompt || "(parallel batch)"}`,
    `status: ${failedCount > 0 ? "partial" : "completed"}`,
    `children: ${children.length}`,
    `completed: ${completedCount}`,
    `failed: ${failedCount}`,
    `used_tools: ${usedTools.length > 0 ? usedTools.join(", ") : "(none)"}`,
    `summary: ${truncateSummary(children.length > 0 ? children.map((child) => child.summary).filter(Boolean).join(" | ") : requestPrompt)}`,
  ];

  if (children.length > 0) {
    lines.push("");
    lines.push("CHILDREN");
    for (const child of children) {
      lines.push(`- [${child.status}] ${child.id}: ${child.prompt}`);
      if (child.summary) {
        lines.push(`  summary: ${child.summary}`);
      }
      if (child.error) {
        lines.push(`  error: ${child.error}`);
      }
    }
  }

  if (failures.length > 0) {
    lines.push("");
    lines.push("FAILURES");
    for (const failure of failures) {
      lines.push(`- ${formatFailureLine(failure)}`);
    }
  }

  return lines.join("\n");
}

function buildCoordinatorDebugTranscript(requestPrompt: string, finalText: string): ChatMessage[] {
  return [
    {
      role: "user",
      content: `Coordinator request: ${requestPrompt || "(parallel batch)"}`,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: finalText }],
    },
  ];
}

async function drainLoop(
  loop: AsyncGenerator<AgentEvent, { reason: TurnEndReason }>,
  onEvent?: (event: AgentEvent) => void,
): Promise<CollectedLoopResult> {
  const events: AgentEvent[] = [];
  let next = await loop.next();

  while (!next.done) {
    events.push(next.value);
    onEvent?.(next.value);
    next = await loop.next();
  }

  return { events, returnValue: next.value };
}

function collectAssistantMessages(messages: ChatMessage[]): string {
  return messages
    .filter((message): message is AssistantMessage => message.role === "assistant")
    .map((message) => extractAssistantText(message))
    .join("");
}

function buildChildTranscript(prompt: string, observedMessages: ChatMessage[]): ChatMessage[] {
  return [
    { role: "user", content: prompt } satisfies UserMessage,
    ...observedMessages,
  ];
}

function resolveTaskRequest(
  baseRequest: SubAgentTaskRequest,
  childRequest: SubAgentTaskRequest,
  id: string,
): ResolvedTaskRequest {
  return {
    id,
    prompt: childRequest.prompt,
    allowedTools: childRequest.allowedTools ?? baseRequest.allowedTools,
    ownedPaths: childRequest.ownedPaths ?? baseRequest.ownedPaths,
    nonOwnedPaths: childRequest.nonOwnedPaths ?? baseRequest.nonOwnedPaths,
    contracts: childRequest.contracts ?? baseRequest.contracts,
    mergeNotes: childRequest.mergeNotes ?? baseRequest.mergeNotes,
    maxTurns: childRequest.maxTurns ?? baseRequest.maxTurns,
    timeoutMs: childRequest.timeoutMs ?? baseRequest.timeoutMs,
    provider: childRequest.provider ?? baseRequest.provider,
    model: childRequest.model ?? baseRequest.model,
    write: childRequest.write ?? baseRequest.write,
    debug: childRequest.debug ?? baseRequest.debug,
  };
}

function resolveChildLimits(childDepth: number, request: SubAgentTaskRequest): {
  maxTurns: number;
  timeoutMs?: number;
  allowWriteTools: boolean;
  allowAgentTool: boolean;
} {
  if (childDepth >= 2) {
    return {
      maxTurns: Math.min(
        Math.max(request.maxTurns ?? SUB_AGENT_DEPTH2_DEFAULT_MAX_TURNS, 1),
        SUB_AGENT_DEPTH2_MAX_TURNS,
      ),
      timeoutMs: Math.min(
        Math.max(request.timeoutMs ?? SUB_AGENT_DEPTH2_DEFAULT_TIMEOUT_MS, 1),
        SUB_AGENT_DEPTH2_MAX_TIMEOUT_MS,
      ),
      allowWriteTools: false,
      allowAgentTool: false,
    };
  }

  return {
    maxTurns: Math.min(Math.max(request.maxTurns ?? SUB_AGENT_DEFAULT_MAX_TURNS, 1), SUB_AGENT_MAX_TURNS),
    timeoutMs: request.timeoutMs,
    allowWriteTools: Boolean(request.write),
    allowAgentTool: true,
  };
}

export class DefaultSubAgentRuntime implements SubAgentRuntime {
  private readonly provider: LLMProvider;
  private readonly tools: Tool[];
  private readonly providerResolver?: SubAgentProviderResolver;
  private readonly onDebugRecord?: (record: SubAgentDebugRecord) => void;
  private readonly maxConcurrentChildren: number;

  constructor(options: DefaultSubAgentRuntimeOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.providerResolver = options.providerResolver;
    this.onDebugRecord = options.onDebugRecord;
    this.maxConcurrentChildren = Math.max(1, options.maxConcurrentChildren ?? SUB_AGENT_DEFAULT_CHILDREN);
  }

  private async selectProvider(
    request: SubAgentTaskRequest,
    context: ToolUseContext,
  ): Promise<LLMProvider> {
    if (!this.providerResolver) {
      return this.provider;
    }

    const resolved = await this.providerResolver({
      request,
      context,
      parentProvider: this.provider,
    });

    return resolved ?? this.provider;
  }

  private buildChildState(context: ToolUseContext, provider: LLMProvider, childTools: Tool[]) {
    const parentPermissionContext = context.permissionContext;
    return createAppState({
      cwd: context.cwd,
      provider,
      tools: childTools,
      permissionMode: parentPermissionContext?.mode === "denyAll" ? "denyAll" : "default",
      permissionRules: parentPermissionContext?.rules ?? [],
      projectMemory: context.projectMemory,
      agentDepth: (context.agentDepth ?? 0) + 1,
      nonInteractive: true,
      sessionId: context.sessionId,
      agentId: `child-depth-${(context.agentDepth ?? 0) + 1}`,
      todoStore: context.todoStore,
      subAgentRuntime: this,
      saveSubAgentRun: context.saveSubAgentRun,
    });
  }

  private async executeChildTask(
    request: ResolvedTaskRequest,
    context: ToolUseContext,
    options: ChildExecutionOptions,
  ): Promise<SubAgentChildResult> {
    const parentDepth = context.agentDepth ?? 0;
    const childDepth = parentDepth + 1;
    if (parentDepth >= SUB_AGENT_MAX_DEPTH) {
      return createChildFailureResult({
        id: options.id,
        prompt: request.prompt,
        status: "failed",
        provider: this.provider,
        write: false,
        reason: "depth_limit",
        message: "Sub-agent depth limit exceeded.",
        model: request.model,
      });
    }

    if (context.abortSignal.aborted) {
      return createChildFailureResult({
        id: options.id,
        prompt: request.prompt,
        status: "aborted",
        provider: this.provider,
        write: false,
        reason: "aborted",
        message: "Sub-agent aborted before start.",
        model: request.model,
      });
    }

    const childLimits = resolveChildLimits(childDepth, request);
    const childAbort = createScopedAbortHandle(
      [context.abortSignal, ...(options.extraAbortSignals ?? [])],
      childLimits.timeoutMs,
    );

    const childTools = buildChildTools(this.tools, request.allowedTools, {
      allowWriteTools: childLimits.allowWriteTools,
      allowAgentTool: childLimits.allowAgentTool,
    });

    try {
      const resolvedProvider = await this.selectProvider(request, context);
      const childState = this.buildChildState(context, resolvedProvider, childTools);
      const childMessages: ChatMessage[] = [{ role: "user", content: request.prompt }];
      const observedMessages: ChatMessage[] = [];
      const usedTools = new Set<string>();
      const startAt = Date.now();
      const shouldCaptureDebug = Boolean(request.debug || options.parentDebug || this.onDebugRecord);

      const linkAbort = () => childState.abortController.abort();
      childAbort.signal.addEventListener("abort", linkAbort, { once: true });

      try {
        const systemPrompt = buildSubAgentSystemPrompt(
          context.cwd,
          childTools,
          request.prompt,
          context.projectMemory,
          resolvedProvider,
          request,
        );

        const loop = agentLoop({
          state: childState,
          messages: childMessages,
          systemPrompt,
          maxTurns: childLimits.maxTurns,
          onMessage: (message) => {
            observedMessages.push(message);
          },
        });

        const loopPromise = drainLoop(loop, (event) => {
          const progress = context.parallelAgentProgress;
          if (!progress) {
            return;
          }

          switch (event.type) {
            case "text_delta":
            case "reasoning_delta":
              progress.sink.onMessage?.(progress.taskId, event.text);
              break;
            case "tool_start":
              progress.sink.onToolStart?.(progress.taskId, event.toolName);
              break;
            case "tool_end":
              progress.sink.onToolEnd?.(progress.taskId, event.toolName, !event.isError);
              break;
            case "turn_end":
              progress.sink.onUsage?.(progress.taskId, {
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
              });
              break;
          }
        })
          .then((collected) => {
            for (const event of collected.events) {
              if (event.type === "tool_end") {
                usedTools.add(event.toolName);
              }
            }

            const assistantMessages = observedMessages.filter(
              (message): message is AssistantMessage => message.role === "assistant",
            );
            const finalAssistant = assistantMessages.at(-1);
            const finalText = finalAssistant ? extractAssistantText(finalAssistant) : "";
            const reason = collected.returnValue.reason;
            const abortCause = resolveAbortCause(childAbort.cause(), options.parentAbortCause?.() ?? null);
            const status: SubAgentChildStatus =
              reason === "completed"
                ? "completed"
                : reason === "aborted"
                  ? (abortCause === "timeout" ? "timeout" : "aborted")
                  : "failed";
            const normalizedReason = abortCause === "timeout" ? "timeout" : reason;
            const summary = truncateSummary(finalText || normalizedReason);
            const usage = toUsage(childState.totalUsage);
            const debugRecord = shouldCaptureDebug
              ? ({
                  id: options.id,
                  kind: options.id === "single" ? "single" : "child",
                  request: makeDebugRequest(request),
                  provider: providerInfo(resolvedProvider),
                  startedAt: startAt,
                  finishedAt: Date.now(),
                  transcript: buildChildTranscript(request.prompt, [
                    ...observedMessages,
                  ]),
                } satisfies SubAgentDebugRecord)
              : undefined;

            if (debugRecord) {
              this.onDebugRecord?.(debugRecord);
            }

            return {
              id: options.id,
              prompt: request.prompt,
              status,
              provider: resolvedProvider.name,
              model: request.model ?? resolvedProvider.model,
              write: childLimits.allowWriteTools,
              finalText,
              summary,
              turns: assistantMessages.length,
              usedTools: [...usedTools],
              usage,
              reason: normalizedReason,
              debug: debugRecord,
              artifacts: buildChildArtifacts({
                status,
                summary,
                finalText,
                usedTools: [...usedTools],
                turns: assistantMessages.length,
                error: status === "completed" ? undefined : finalText || summary,
              }),
            } satisfies SubAgentChildResult;
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            const cause = resolveAbortCause(childAbort.cause(), options.parentAbortCause?.() ?? null);
            const status: SubAgentChildStatus = cause === "timeout" ? "timeout" : context.abortSignal.aborted ? "aborted" : "failed";
            const normalizedReason = cause === "timeout" ? "timeout" : context.abortSignal.aborted ? "aborted" : "error";
            const debugRecord = shouldCaptureDebug
              ? ({
                  id: options.id,
                  kind: options.id === "single" ? "single" : "child",
                  request: makeDebugRequest(request),
                  provider: providerInfo(resolvedProvider),
                  startedAt: startAt,
                  finishedAt: Date.now(),
                  transcript: buildChildTranscript(request.prompt, observedMessages),
                } satisfies SubAgentDebugRecord)
              : undefined;

            if (debugRecord) {
              this.onDebugRecord?.(debugRecord);
            }

            return createChildFailureResult({
              id: options.id,
              prompt: request.prompt,
              status,
              provider: resolvedProvider,
              write: childLimits.allowWriteTools,
              reason: normalizedReason,
              message,
              model: request.model ?? resolvedProvider.model,
              debug: debugRecord,
            });
          })
          .finally(() => {
            childAbort.cleanup();
            childState.abortController.abort();
            childAbort.signal.removeEventListener("abort", linkAbort);
          });

        const abortPromise = new Promise<SubAgentChildResult>((resolve) => {
          if (childAbort.signal.aborted) {
            const cause = resolveAbortCause(childAbort.cause(), options.parentAbortCause?.() ?? null);
            resolve(
              createChildFailureResult({
                id: options.id,
                prompt: request.prompt,
                status: cause === "timeout" ? "timeout" : "aborted",
                provider: resolvedProvider,
                write: childLimits.allowWriteTools,
                reason: cause === "timeout" ? "timeout" : "aborted",
                message: cause === "timeout" ? "Sub-agent timed out." : "Sub-agent aborted.",
                model: request.model ?? resolvedProvider.model,
              }),
            );
            return;
          }

          const listener = () => {
            const cause = resolveAbortCause(childAbort.cause(), options.parentAbortCause?.() ?? null);
            resolve(
              createChildFailureResult({
                id: options.id,
                prompt: request.prompt,
                status: cause === "timeout" ? "timeout" : "aborted",
                provider: resolvedProvider,
                write: childLimits.allowWriteTools,
                reason: cause === "timeout" ? "timeout" : "aborted",
                message: cause === "timeout" ? "Sub-agent timed out." : "Sub-agent aborted.",
                model: request.model ?? resolvedProvider.model,
              }),
            );
          };

          childAbort.signal.addEventListener("abort", listener, { once: true });
        });

        const result = await Promise.race([loopPromise, abortPromise]);
        return result;
      } finally {
        childAbort.cleanup();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const debugRecord = request.debug || options.parentDebug || this.onDebugRecord
        ? ({
            id: options.id,
            kind: options.id === "single" ? "single" : "child",
            request: makeDebugRequest(request),
            provider: providerInfo(this.provider),
            startedAt: Date.now(),
            finishedAt: Date.now(),
            transcript: [{ role: "user", content: request.prompt }],
          } satisfies SubAgentDebugRecord)
        : undefined;

      if (debugRecord) {
        this.onDebugRecord?.(debugRecord);
      }

      return createChildFailureResult({
        id: options.id,
        prompt: request.prompt,
        status: "failed",
        provider: this.provider,
        write: childLimits.allowWriteTools,
        reason: "error",
        message,
        model: request.model ?? this.provider.model,
        debug: debugRecord,
      });
    }
  }

  private toSingleResult(child: SubAgentChildResult): SubAgentResult {
    const result: SubAgentResult = {
      finalText: child.finalText,
      summary: child.summary,
      turns: child.turns,
      usedTools: child.usedTools,
      usage: child.usage,
      reason: child.reason,
      artifacts: child.artifacts ?? buildChildArtifacts({
        status: child.status,
        summary: child.summary,
        finalText: child.finalText,
        usedTools: child.usedTools,
        turns: child.turns,
        error: child.error,
      }),
    };

    if (child.debug) {
      result.debug = child.debug;
    }

    return result;
  }

  private buildCoordinatorResult(
    request: SubAgentTaskRequest,
    children: SubAgentChildResult[],
    parentDebug: boolean,
  ): SubAgentResult {
    const failures: SubAgentFailure[] = [];
    let reason: string = "completed";
    let partial = false;

    for (const child of children) {
      if (child.status !== "completed") {
        partial = true;
        if (child.status === "timeout") {
          reason = "error";
        } else if (child.status === "aborted") {
          reason = child.reason === "aborted" ? "aborted" : "error";
        } else {
          reason = "error";
        }

        failures.push({
          id: child.id,
          prompt: child.prompt,
          status: child.status,
          provider: child.provider,
          model: child.model,
          write: child.write,
          message: child.error ?? child.summary,
        });
      }
    }

    const finalText = buildCoordinatorFinalText(request.prompt, children, failures);
    const summary = truncateSummary(finalText);
    const completedCount = children.filter((child) => child.status === "completed").length;
    const result: SubAgentResult = {
      finalText,
      summary,
      turns: children.reduce((sum, child) => sum + child.turns, 0),
      usedTools: uniqueToolNames(children),
      usage: sumUsage(children),
      reason,
      coordinator: true,
      partial,
      childCount: children.length,
      completedCount,
      failedCount: failures.length,
      children,
      failures: failures.length > 0 ? failures : undefined,
      artifacts: buildCoordinatorArtifacts({
        partial,
        childCount: children.length,
        completedCount,
        failedCount: failures.length,
        summary,
        finalText,
        usedTools: uniqueToolNames(children),
        turns: children.reduce((sum, child) => sum + child.turns, 0),
      }),
      debug: parentDebug || Boolean(this.onDebugRecord)
        ? ({
            id: "coordinator",
            kind: "coordinator",
            request: makeDebugRequest(request, children.length),
            provider: providerInfo(this.provider),
            startedAt: Date.now(),
            finishedAt: Date.now(),
            transcript: buildCoordinatorDebugTranscript(request.prompt, finalText),
          } satisfies SubAgentDebugRecord)
        : undefined,
    };

    if (result.debug) {
      this.onDebugRecord?.(result.debug);
    }

    return result;
  }

  private async runTaskBatch(
    requests: SubAgentTaskRequest[],
    context: ToolUseContext,
    parentRequest: SubAgentTaskRequest,
  ): Promise<SubAgentResult> {
    if (requests.length === 0) {
      return createEmptyResult("completed", "No sub-agent tasks were provided.");
    }

    const parentAbort = createScopedAbortHandle([context.abortSignal], parentRequest.timeoutMs);

    try {
      const children: SubAgentChildResult[] = [];

      for (let start = 0; start < requests.length; start += this.maxConcurrentChildren) {
        if (parentAbort.signal.aborted || context.abortSignal.aborted) {
          break;
        }

        const batchRequests = requests.slice(start, start + this.maxConcurrentChildren);
        const batch = batchRequests.map((request, batchOffset) => {
          const absoluteIndex = start + batchOffset;
          const resolved = resolveTaskRequest(parentRequest, request, `child-${absoluteIndex + 1}`);
          return this.executeChildTask(resolved, context, {
            id: resolved.id,
            parentDebug: Boolean(parentRequest.debug || this.onDebugRecord),
            parentAbortCause: () => parentAbort.cause(),
            extraAbortSignals: [parentAbort.signal],
          });
        });

        const settled = await Promise.allSettled(batch);
        for (const [batchOffset, outcome] of settled.entries()) {
          if (outcome.status === "fulfilled") {
            children.push(outcome.value);
          } else {
            const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            const absoluteIndex = start + batchOffset;
            children.push({
              id: `child-${absoluteIndex + 1}`,
              prompt: "(unknown)",
              status: parentAbort.cause() === "timeout" ? "timeout" : "failed",
              provider: this.provider.name,
              model: this.provider.model,
              write: false,
              finalText: message,
              summary: truncateSummary(message),
              turns: 0,
              usedTools: [],
              usage: EMPTY_USAGE,
              reason: parentAbort.cause() === "timeout" ? "timeout" : "error",
              error: message,
            });
          }
        }

        if (parentAbort.signal.aborted || context.abortSignal.aborted) {
          const skippedStart = start + batchRequests.length;
          for (let skipped = skippedStart; skipped < requests.length; skipped += 1) {
            const skippedRequest = resolveTaskRequest(parentRequest, requests[skipped]!, `child-${skipped + 1}`);
            const cause = parentAbort.cause() === "timeout" ? "timeout" : "aborted";
            const skippedDebug = parentRequest.debug || this.onDebugRecord
              ? {
                  id: skippedRequest.id,
                  kind: "child" as const,
                  request: makeDebugRequest(skippedRequest),
                  provider: providerInfo(this.provider),
                  startedAt: Date.now(),
                  finishedAt: Date.now(),
                  transcript: buildChildTranscript(skippedRequest.prompt, []),
                }
              : undefined;

            if (skippedDebug) {
              this.onDebugRecord?.(skippedDebug);
            }

            children.push(
              createSkippedChildFailureResult({
                id: skippedRequest.id,
                prompt: skippedRequest.prompt,
                status: cause === "timeout" ? "timeout" : "aborted",
                provider: this.provider,
                write: Boolean(skippedRequest.write),
                reason: cause,
                message: cause === "timeout" ? "Sub-agent timed out before start." : "Sub-agent aborted before start.",
                model: skippedRequest.model ?? this.provider.model,
                debug: skippedDebug,
              }),
            );
          }
          break;
        }
      }

      if (children.length === 0 && parentAbort.signal.aborted) {
        return createEmptyResult(parentAbort.cause() === "timeout" ? "error" : "aborted", "Sub-agent batch aborted.");
      }

      return this.buildCoordinatorResult(parentRequest, children, Boolean(parentRequest.debug || this.onDebugRecord));
    } finally {
      parentAbort.cleanup();
    }
  }

  private async runPipelineMode(
    stages: PipelineStage[],
    context: ToolUseContext,
    parentRequest: SubAgentRequest,
  ): Promise<SubAgentResult> {
    const executor = async (
      req: {
        prompt: string;
        provider?: string;
        model?: string;
        timeoutMs?: number;
        allowedTools?: string[];
        ownedPaths?: string[];
        nonOwnedPaths?: string[];
        contracts?: string[];
        mergeNotes?: string;
      },
      signal?: AbortSignal,
    ): Promise<PipelineStageExecResult> => {
          const child = await this.executeChildTask(
        {
          id: `pipeline-stage`,
          prompt: req.prompt,
          allowedTools: req.allowedTools ?? parentRequest.allowedTools,
          ownedPaths: req.ownedPaths ?? parentRequest.ownedPaths,
          nonOwnedPaths: req.nonOwnedPaths ?? parentRequest.nonOwnedPaths,
          contracts: req.contracts ?? parentRequest.contracts,
          mergeNotes: req.mergeNotes ?? parentRequest.mergeNotes,
          maxTurns: parentRequest.maxTurns,
          timeoutMs: req.timeoutMs,
          provider: req.provider ?? parentRequest.provider,
          model: req.model ?? parentRequest.model,
          write: parentRequest.write,
          debug: parentRequest.debug,
        },
        { ...context, abortSignal: signal ?? context.abortSignal },
        { id: `pipeline-stage`, parentDebug: Boolean(parentRequest.debug) },
      );
      return {
        status: child.status === "completed" ? "completed" : child.status === "timeout" ? "timeout" : child.status === "aborted" ? "aborted" : "failed",
        text: child.finalText,
        usage: child.usage,
        provider: child.provider,
        model: child.model,
        error: child.error,
      };
    };

    const result = await runPipeline(
      {
        stages,
        goal: parentRequest.prompt,
        onStageFailure: "stop",
        defaultTimeoutMs: parentRequest.timeoutMs,
      },
      executor,
      context.abortSignal,
    );

    const lines = [
      "PIPELINE_RESULT",
      `goal: ${parentRequest.prompt}`,
      `stages: ${result.stages.length}`,
      `completed: ${result.completedCount}`,
      `failed: ${result.failedCount}`,
      `skipped: ${result.skippedCount}`,
      "",
      ...result.stages.map(
        (s) => `- stage-${s.stageIndex + 1} [${s.status}]: ${s.prompt}${s.error ? ` (${s.error})` : ""}`,
      ),
    ];
    if (result.finalText) {
      lines.push("", "FINAL_OUTPUT", result.finalText);
    }

    const finalText = lines.join("\n");
    const summary = finalText.length > 240 ? `${finalText.slice(0, 239)}…` : finalText;

    return {
      finalText,
      summary,
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

  async run(request: SubAgentRequest, context: ToolUseContext): Promise<SubAgentResult> {
    const agentDepth = context.agentDepth ?? 0;
    if (agentDepth >= SUB_AGENT_MAX_DEPTH) {
      return createDeniedResult("Sub-agent depth limit exceeded.");
    }

    if (context.abortSignal.aborted) {
      return createEmptyResult("aborted", "Sub-agent aborted before start.");
    }

    if (request.pipeline && request.pipeline.length > 0) {
      if (request.subtasks && request.subtasks.length > 0) {
        return createEmptyResult("error", "Cannot use both 'pipeline' and 'subtasks' in the same request.");
      }
      return this.runPipelineMode(request.pipeline, context, request);
    }

    if (request.subtasks && request.subtasks.length > 0) {
      return this.runTaskBatch(request.subtasks, context, request);
    }

    const child = await this.executeChildTask(
      {
        id: "single",
        prompt: request.prompt,
        allowedTools: request.allowedTools,
        maxTurns: request.maxTurns,
        timeoutMs: request.timeoutMs,
        provider: request.provider,
        model: request.model,
        write: request.write,
        debug: request.debug,
      },
      context,
      {
        id: "single",
        parentDebug: Boolean(request.debug),
      },
    );

    return this.toSingleResult(child);
  }

  async runMany(requests: SubAgentTaskRequest[], context: ToolUseContext): Promise<SubAgentResult> {
    const agentDepth = context.agentDepth ?? 0;
    if (agentDepth >= SUB_AGENT_MAX_DEPTH) {
      return createDeniedResult("Sub-agent depth limit exceeded.");
    }

    return this.runTaskBatch(
      requests,
      context,
      {
        prompt: "Parallel sub-agent batch",
        debug: false,
      },
    );
  }
}
