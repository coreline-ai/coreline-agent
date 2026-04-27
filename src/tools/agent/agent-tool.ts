/**
 * AgentTool — delegated sub-agent execution.
 */

import { z } from "zod";
import { buildTool } from "../types.js";
import type { ToolResult, ToolUseContext, PermissionResult } from "../types.js";
import { startParallelAgentBackgroundTask } from "../../agent/parallel/background-runner.js";
import { appendWorkstreamCardToPrompt } from "../../agent/parallel/policy-envelope.js";
import {
  extractSubagentType,
  recordSubagentRun,
} from "../../agent/self-improve/subagent-tracker.js";
import type {
  SubAgentArtifact,
  SubAgentChildResult,
  SubAgentDebugRecord,
  SubAgentRequest,
  SubAgentResult,
  SubAgentTaskRequest,
} from "../../agent/subagent-types.js";

const MAX_RESULT_SUMMARY_CHARS = 240;

type AgentToolInput = SubAgentRequest & {
  runInBackground?: boolean;
  description?: string;
} & Record<string, unknown>;

const SubtaskSchema = z.object({
  prompt: z.string().min(1).describe("Delegated task for this child sub-agent"),
  allowedTools: z.array(z.string()).optional().describe("Optional child allowed tool subset"),
  ownedPaths: z.array(z.string()).optional().describe("Files this child owns for parallel work"),
  nonOwnedPaths: z.array(z.string()).optional().describe("Files this child may reference but not edit"),
  contracts: z.array(z.string()).optional().describe("Shared contracts or handoff rules for this child"),
  mergeNotes: z.string().optional().describe("Merge guidance for this child result"),
  maxTurns: z.number().int().min(1).optional().describe("Optional child turn limit"),
  timeoutMs: z.number().int().positive().optional().describe("Optional child timeout in milliseconds"),
  provider: z.string().min(1).optional().describe("Optional child provider override"),
  model: z.string().min(1).optional().describe("Optional child model override"),
  write: z.boolean().optional().describe("Allow write-capable child tools for this subtask"),
  debug: z.boolean().optional().describe("Capture child transcript/debug metadata"),
});

function summarize(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no final text)";
  }
  if (normalized.length <= MAX_RESULT_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RESULT_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function formatUsage(usage: SubAgentResult["usage"]): string {
  return `input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens}`;
}

function formatUsedTools(usedTools: string[]): string {
  return usedTools.length > 0 ? usedTools.join(", ") : "(none)";
}

function formatArtifacts(artifacts?: SubAgentArtifact[]): string[] {
  if (!artifacts || artifacts.length === 0) {
    return [];
  }

  const lines: string[] = ["ARTIFACTS"];
  for (const artifact of artifacts) {
    lines.push(`- ${artifact.label}: ${artifact.value}`);
  }
  return lines;
}

function formatFinalText(finalText: string): string {
  return finalText.trim() || "(no final text)";
}

function isWriteCapableRequest(input: AgentToolInput): boolean {
  if (input.write) {
    return true;
  }

  return Boolean(input.subtasks?.some((subtask) => subtask.write));
}

function normalizeRecordStatus(reason?: string): "completed" | "error" | "aborted" {
  if (reason === "completed") {
    return "completed";
  }

  if (reason === "aborted") {
    return "aborted";
  }

  return "error";
}

function saveDebugRecord(
  context: ToolUseContext,
  params: {
    childId: string;
    prompt?: string;
    providerName?: string;
    model?: string;
    turns?: number;
    usedTools?: string[];
    summary?: string;
    finalText?: string;
    success?: boolean;
    reason?: string;
    error?: string;
    debug?: SubAgentDebugRecord;
    resultKind?: "single" | "child" | "coordinator";
    childCount?: number;
    completedCount?: number;
    failedCount?: number;
    partial?: boolean;
    artifacts?: SubAgentArtifact[];
    displayTitle?: string;
    displaySummary?: string;
  },
) {
  if (!context.saveSubAgentRun) {
    return;
  }

  const debug = params.debug;
  context.saveSubAgentRun({
    childId: params.childId,
    createdAt: new Date(debug?.finishedAt ?? Date.now()).toISOString(),
    cwd: context.cwd,
    providerName: params.providerName ?? debug?.provider.name,
    model: params.model ?? debug?.provider.model,
    agentDepth: (context.agentDepth ?? 0) + 1,
    usedTools: params.usedTools,
    prompt: params.prompt ?? debug?.request.prompt,
    summary: params.summary,
    finalText: params.finalText,
    turns: params.turns,
    success: params.success,
    status: normalizeRecordStatus(params.reason),
    error: params.error,
    transcript: debug?.transcript,
    resultKind: params.resultKind,
    childCount: params.childCount,
    completedCount: params.completedCount,
    failedCount: params.failedCount,
    partial: params.partial,
    artifacts: params.artifacts,
    displayTitle: params.displayTitle,
    displaySummary: params.displaySummary,
  });
}

function persistChildResult(child: SubAgentChildResult, context: ToolUseContext) {
  saveDebugRecord(context, {
    childId: child.id,
    prompt: child.prompt,
    providerName: child.provider,
    model: child.model,
    turns: child.turns,
    usedTools: child.usedTools,
    summary: child.summary,
    finalText: child.finalText,
    success: child.status === "completed",
    reason: child.reason,
    error: child.error,
    debug: child.debug,
    resultKind: "child",
    artifacts: child.artifacts,
    displayTitle: `${child.id}${child.model ? ` @ ${child.model}` : ""}`,
    displaySummary: child.summary,
  });

  try {
    const projectId = context.projectMemory?.projectId ?? "";
    const sessionId = context.sessionId ?? "";
    if (projectId) {
      recordSubagentRun(projectId, {
        subagentType: extractSubagentType(child.prompt ?? ""),
        parentSessionId: sessionId,
        // Consistent with saveSubAgentRun in saveDebugRecord (L136) which uses +1.
        // Child evidence records the delta from the context caller's depth.
        agentDepth: (context.agentDepth ?? 0) + 1,
        outcome: {
          success: child.status === "completed",
          turnsUsed: child.turns,
          toolCalls: child.usedTools?.length,
          unclearPoints: [],
        },
        metadata: {
          childId: child.id,
          reason: child.reason,
          status: child.status,
          usedToolNames: child.usedTools,
          provider: child.provider,
          model: child.model,
        },
      });
    }
  } catch {
    // best-effort
  }
}

function persistSubAgentRuns(result: SubAgentResult, input: SubAgentRequest, context: ToolUseContext) {
  if (context.saveSubAgentRun) {
    if (result.children?.length) {
      for (const child of result.children) {
        persistChildResult(child, context);
      }

      if (result.debug) {
        saveDebugRecord(context, {
          childId: result.debug.id,
          prompt: input.prompt,
          providerName: result.debug.provider.name,
          model: result.debug.provider.model,
          turns: result.turns,
          usedTools: result.usedTools,
          summary: result.summary,
          finalText: result.finalText,
          success: result.reason === "completed" && !result.partial,
          reason: result.reason,
          error: result.failures?.map((failure) => failure.message).join("; "),
          debug: result.debug,
          resultKind: "coordinator",
          childCount: result.childCount,
          completedCount: result.completedCount,
          failedCount: result.failedCount,
          partial: result.partial,
          artifacts: result.artifacts,
          displayTitle: "coordinator",
          displaySummary: result.summary,
        });
      }
    } else {
      saveDebugRecord(context, {
        childId: result.debug?.id ?? "single",
        prompt: input.prompt,
        providerName: result.debug?.provider.name,
        model: result.debug?.provider.model,
        turns: result.turns,
        usedTools: result.usedTools,
        summary: result.summary,
        finalText: result.finalText,
        success: result.reason === "completed",
        reason: result.reason,
        error: result.reason === "completed" ? undefined : result.finalText || result.summary,
        debug: result.debug,
        resultKind: "single",
        artifacts: result.artifacts,
        displayTitle: result.debug?.id ?? "single",
        displaySummary: result.summary,
      });
    }
  }

  try {
    const projectId = context.projectMemory?.projectId ?? "";
    const sessionId = context.sessionId ?? "";
    if (projectId) {
      recordSubagentRun(projectId, {
        subagentType: extractSubagentType(input.prompt),
        parentSessionId: sessionId,
        agentDepth: (context.agentDepth ?? 0) + 1,
        outcome: {
          success: result.reason === "completed" && !result.partial,
          turnsUsed: result.turns,
          toolCalls: result.usedTools?.length,
          unclearPoints: [],
        },
        metadata: {
          partial: Boolean(result.partial),
          failedCount: result.failedCount ?? 0,
          completedCount: result.completedCount ?? 0,
          childCount: result.childCount ?? (result.children?.length ?? 0),
          reason: result.reason,
          usedToolNames: result.usedTools,
        },
      });
    }
  } catch {
    // best-effort
  }
}

function formatChildResultLine(child: SubAgentChildResult): string {
  const tools = formatUsedTools(child.usedTools);
  const summary = child.summary ? ` summary=${summarize(child.summary)}` : "";
  return `- ${child.id} [${child.status}] provider=${child.provider}${child.model ? ` model=${child.model}` : ""} tools=${tools} turns=${child.turns}${summary}`;
}

function withDefaultDebug(input: AgentToolInput, context: ToolUseContext): SubAgentRequest {
  const prompt = appendWorkstreamCardToPrompt(input.prompt, {
    prompt: input.prompt,
    ownedPaths: input.ownedPaths,
    nonOwnedPaths: input.nonOwnedPaths,
    contracts: input.contracts,
    mergeNotes: input.mergeNotes,
    canWrite: Boolean(input.write),
  });

  return {
    ...input,
    prompt,
    debug: input.debug ?? Boolean(context.saveSubAgentRun),
    subtasks: input.subtasks?.map((subtask) => ({
      ...subtask,
      prompt: appendWorkstreamCardToPrompt(subtask.prompt, {
        prompt: subtask.prompt,
        ownedPaths: subtask.ownedPaths ?? input.ownedPaths,
        nonOwnedPaths: subtask.nonOwnedPaths ?? input.nonOwnedPaths,
        contracts: subtask.contracts ?? input.contracts,
        mergeNotes: subtask.mergeNotes ?? input.mergeNotes,
        canWrite: Boolean(subtask.write ?? input.write),
      }),
      debug: subtask.debug ?? input.debug ?? Boolean(context.saveSubAgentRun),
    })),
    pipeline: input.pipeline?.map((stage) => ({
      ...stage,
      prompt: appendWorkstreamCardToPrompt(stage.prompt, {
        prompt: stage.prompt,
        ownedPaths: stage.ownedPaths ?? input.ownedPaths,
        nonOwnedPaths: stage.nonOwnedPaths ?? input.nonOwnedPaths,
        contracts: stage.contracts ?? input.contracts,
        mergeNotes: stage.mergeNotes ?? input.mergeNotes,
        canWrite: Boolean(input.write),
      }),
    })),
  };
}

function createBackgroundUnavailableResult(message: string): SubAgentResult {
  return {
    finalText: message,
    summary: message,
    turns: 0,
    usedTools: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    reason: "background_unavailable",
    artifacts: [{ kind: "failure", label: "error", value: message }],
  };
}

function createBackgroundStartedResult(taskId: string, description?: string): SubAgentResult {
  const summary = `Background parallel agent task started: ${taskId}`;
  const finalText = [
    "PARALLEL_AGENT_TASK_STARTED",
    `task_id: ${taskId}`,
    description ? `description: ${description}` : undefined,
    `status_command: /agent status ${taskId}`,
    `read_command: /agent read ${taskId}`,
    `stop_command: /agent stop ${taskId}`,
  ].filter((line): line is string => Boolean(line)).join("\n");

  return {
    finalText,
    summary,
    turns: 0,
    usedTools: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    reason: "completed",
    artifacts: [
      { kind: "status", label: "status", value: "background_started" },
      { kind: "status", label: "task id", value: taskId },
      { kind: "summary", label: "summary", value: summary },
    ],
  };
}

export const AgentTool = buildTool<AgentToolInput, SubAgentResult>({
  name: "Agent",
  description:
    "Spawn delegated sub-agents for research, code review, test execution, or bounded multi-child coordination. " +
    "Returns a compact result plus optional child/coordinator metadata.",
  maxResultSizeChars: 100_000,

  inputSchema: z.object({
    prompt: z.string().min(1).describe("Delegated task for the sub-agent"),
    description: z.string().optional().describe("Short operator-facing label for this delegated task"),
    runInBackground: z.boolean().optional().describe("Start this delegation as a background parallel-agent task when supported"),
    allowedTools: z.array(z.string()).optional().describe("Optional allowed tool subset"),
    ownedPaths: z.array(z.string()).optional().describe("Files owned by this delegation"),
    nonOwnedPaths: z.array(z.string()).optional().describe("Files this delegation may reference but not edit"),
    contracts: z.array(z.string()).optional().describe("Shared contracts or handoff rules for this delegation"),
    mergeNotes: z.string().optional().describe("Merge guidance for this delegation"),
    maxTurns: z.number().int().min(1).optional().describe("Optional child turn limit"),
    timeoutMs: z.number().int().positive().optional().describe("Optional child timeout in milliseconds"),
    provider: z.string().min(1).optional().describe("Optional child provider override"),
    model: z.string().min(1).optional().describe("Optional child model override"),
    write: z.boolean().optional().describe("Allow write-capable child tools"),
    debug: z.boolean().optional().describe("Capture child transcript/debug metadata"),
    subtasks: z.array(SubtaskSchema).min(1).optional().describe("Optional child subtask batch for coordinated execution"),
    pipeline: z.array(z.object({
      prompt: z.string().min(1).describe("Prompt for this pipeline stage"),
      contextPrefix: z.string().optional().describe("Prefix before injecting previous stage result"),
      ownedPaths: z.array(z.string()).optional().describe("Files owned by this pipeline stage"),
      nonOwnedPaths: z.array(z.string()).optional().describe("Files this pipeline stage may reference but not edit"),
      contracts: z.array(z.string()).optional().describe("Shared contracts or handoff rules for this pipeline stage"),
      mergeNotes: z.string().optional().describe("Merge guidance for this pipeline stage"),
      provider: z.string().optional().describe("Provider override for this stage"),
      model: z.string().optional().describe("Model override for this stage"),
      timeoutMs: z.number().int().positive().optional().describe("Timeout for this stage"),
      allowedTools: z.array(z.string()).optional().describe("Allowed tools for this stage"),
    })).min(2).optional().describe("Sequential handoff chain — each stage receives the previous stage result as context"),
  }),

  isReadOnly: (input) => !isWriteCapableRequest(input),
  isConcurrencySafe: () => false,

  checkPermissions: (input, context: ToolUseContext): PermissionResult => {
    if ((context.agentDepth ?? 0) >= 2) {
      return {
        behavior: "deny",
        reason: "Agent tool is disabled at depth 2 or deeper.",
      };
    }

    if (isWriteCapableRequest(input)) {
      return {
        behavior: "ask",
        reason: "Delegated child requested write-capable tools. Confirm before spawning this child.",
      };
    }

    return { behavior: "allow", reason: "Delegation is allowed from the root agent." };
  },

  async call(input, context: ToolUseContext): Promise<ToolResult<SubAgentResult>> {
    const runtime = context.subAgentRuntime;
    if (!runtime) {
      const message = "Sub-agent runtime is not available in this session.";
      return {
        data: {
          finalText: message,
          summary: message,
          turns: 0,
          usedTools: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          reason: "runtime_unavailable",
        },
        isError: true,
      };
    }

    const runtimeInput = withDefaultDebug(input, context);

    if (input.runInBackground) {
      if (!context.supportsBackgroundTasks || !context.parallelAgentScheduler) {
        const message = "Background parallel agent tasks are only supported in interactive TUI sessions.";
        return {
          data: createBackgroundUnavailableResult(message),
          isError: true,
        };
      }

      const task = startParallelAgentBackgroundTask({
        scheduler: context.parallelAgentScheduler,
        runtime,
        context,
        request: runtimeInput,
        description: input.description,
      });
      return {
        data: createBackgroundStartedResult(task.id, input.description),
        isError: false,
      };
    }

    const result = await runtime.run(runtimeInput, context);
    persistSubAgentRuns(result, runtimeInput, context);

    return {
      data: result,
      isError: result.reason !== "completed",
    };
  },

  formatResult(output: SubAgentResult): string {
    const artifacts = formatArtifacts(output.artifacts);
    const mode = output.coordinator ? "coordinator" : "single";
    const status = output.partial ? "partial" : output.reason ?? "completed";
    const lines = [
      "AGENT_RESULT",
      `reason: ${output.reason ?? "completed"}`,
      `mode: ${mode}`,
      `status: ${status}`,
      `turns: ${output.turns}`,
      `child_count: ${output.childCount ?? (output.children?.length ?? (output.coordinator ? 0 : 1))}`,
      `completed_count: ${output.completedCount ?? 0}`,
      `failed_count: ${output.failedCount ?? (output.failures?.length ?? 0)}`,
      `used_tools: ${formatUsedTools(output.usedTools)}`,
      `usage: ${formatUsage(output.usage)}`,
      `summary: ${summarize(output.summary)}`,
    ];

    if (artifacts.length > 0) {
      lines.push("");
      lines.push(...artifacts);
    }

    if (output.children?.length) {
      lines.push("");
      lines.push("CHILDREN");
      for (const child of output.children) {
        lines.push(formatChildResultLine(child));
      }
    }

    if (output.failures?.length) {
      lines.push("");
      lines.push("FAILURES");
      for (const failure of output.failures) {
        lines.push(`- ${failure.id} [${failure.status}] ${failure.message}`);
      }
    }

    lines.push("");
    lines.push("FINAL_TEXT_START");
    lines.push(formatFinalText(output.finalText));
    lines.push("FINAL_TEXT_END");

    return lines.join("\n");
  },
});
