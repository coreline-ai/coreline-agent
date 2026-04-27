/**
 * REPL — main interactive component.
 * Orchestrates: PromptInput → agentLoop → StreamingOutput + ToolResult → repeat.
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { randomUUID } from "node:crypto";
import type { AppState } from "../agent/context.js";
import type { LLMProvider, ProviderRegistry } from "../providers/types.js";
import type { AgentEvent, ChatMessage } from "../agent/types.js";
import type { SessionManager } from "../session/history.js";
import { agentLoop } from "../agent/loop.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { compactMessages } from "../agent/context-manager.js";
import { buildPlan, executePlan, runAutopilot, type AutopilotRunResult } from "../agent/plan-execute/index.js";
import { loadPermissions, loadProviders, loadSettings } from "../config/loader.js";
import { findRole, loadRoles, type Role } from "../config/roles.js";
import { formatAtFileIssues, prepareUserPrompt, summarizePromptForDisplay } from "../prompt/index.js";
import { deletePrompt, findPrompt, listPrompts, savePrompt } from "../prompt/library.js";
import { ProviderRegistryImpl } from "../providers/registry.js";
import { estimateTokens } from "../utils/token-estimator.js";
import { handleSlashCommand } from "./slash-commands.js";
import { PromptInput } from "./prompt-input.js";
import { StreamingOutput } from "./streaming-output.js";
import { ToolResult, type ToolCallDisplay } from "./tool-result.js";
import { StatusBar, type ProxyStatus } from "./status-bar.js";
import type { AgentStatusSnapshot, AgentStatus, StatusTracker } from "../agent/status.js";
import { ProviderSwitcher } from "./provider-switcher.js";
import { PermissionPrompt } from "./permission-prompt.js";
import { AskUserQuestionPrompt } from "./ask-user-question-prompt.js";
import type {
  AskUserQuestionHandler,
  AskUserQuestionQuestion,
  AskUserQuestionResponse,
} from "../tools/ask-user-question/index.js";
import { ReasoningOutput } from "./reasoning-output.js";
import { resolveCycleProvider, resolveNumericProvider } from "./provider-shortcut.js";
import { createRootSubAgentRuntime } from "../agent/subagent-root.js";
import { runTestFixLoopToCompletion } from "../agent/test-loop.js";
import type { EvaluationResult, PlanExecutionContext, PlanExecutionStep, Task } from "../agent/plan-execute/types.js";
import type { PlanExecutionResult } from "../agent/plan-execute/runner.js";
import type { PlanRunMode, PlanRunRecord, PlanRunStatus, PlanStepRecord } from "../session/records.js";
import { summarizeTaskResult } from "../agent/plan-execute/output.js";
import { searchTranscripts } from "../session/search.js";
import { replaySession } from "../session/replay.js";
import { exportSessionMarkdown, exportSessionPrDescription, exportSessionToText } from "../session/export.js";
import { parseWatchdogTimeoutSeconds, ProgressWatchdog, type WatchdogSnapshot } from "../agent/watchdog.js";
import { listBuiltInSkills, formatSkillForDisplay, assertBuiltInSkillId } from "../skills/registry.js";
import { selectBuiltInSkills } from "../skills/router.js";
import type { BuiltInSkillId } from "../skills/types.js";
import { readEvidence } from "../agent/self-improve/evidence.js";
import { summariseEval } from "../agent/self-improve/eval.js";
import { collectContextCandidates } from "../agent/context-collector.js";
import { parsePromptMacro, validatePromptMacro } from "../prompt/macro.js";
import type { ParallelAgentTaskRecord } from "../agent/parallel/types.js";
import { formatParallelAgentTaskBlock, formatParallelAgentTaskCollection } from "../agent/parallel/result-collector.js";
import { RuntimeTweaks } from "../config/runtime-tweaks.js";
import { generateScaffold, type ScaffoldKind } from "../scaffold/index.js";
import { createForkVerifierTaskWork, detectVerificationCommands } from "../agent/fork-verifier.js";
import { startAutoVerifier } from "../agent/auto-verifier.js";
import { SnipRegistry } from "../agent/context-snip.js";
import { handleFactCommand, type FactCommandData } from "./handlers/fact-handler.js";
import { handleDecayCommand, type DecayCommandData } from "./handlers/decay-handler.js";
import { handleLinkCommand, type LinkCommandData } from "./handlers/link-handler.js";
import {
  handleSearchPreciseCommand,
  type SearchPreciseCommandData,
} from "./handlers/search-precise-handler.js";
import { handleIncidentCommand, type IncidentCommandData } from "./handlers/incident-handler.js";
import { handleDecisionCommand, type DecisionCommandData } from "./handlers/decision-handler.js";
import {
  handleEvidenceFirstCommand,
  type EvidenceFirstCommandData,
} from "./handlers/evidence-first-handler.js";
import { handleRunbookCommand, type RunbookCommandData } from "./handlers/runbook-handler.js";
import { handleRcaCommand, type RcaCommandData } from "./handlers/rca-handler.js";
import { handleMemoryHealthCommand } from "./handlers/memory-health-handler.js";
import {
  handleEvidenceRotateCommand,
  type EvidenceRotateData,
} from "./handlers/evidence-rotate-handler.js";
import {
  handleBrandSpecCommand,
  type BrandSpecCommandData,
} from "./handlers/brand-spec-handler.js";
import {
  handleSlopCheck,
  type SlopCheckCommandData,
} from "./handlers/slop-handler.js";
import {
  handleCritiqueCommand,
  type CritiqueCommandData,
} from "./handlers/critique-handler.js";
import type { HandlerContext } from "./handlers/types.js";

// ---------------------------------------------------------------------------
// Message display types
// ---------------------------------------------------------------------------

interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ToolCallDisplay[];
}

function isToolResultOnlyUserMessage(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return summarizePromptForDisplay(content);
  return summarizePromptForDisplay(content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(""));
}

function contentToPromptText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

function formatWatchdogStatus(timeoutSeconds?: number, snapshot?: WatchdogSnapshot | null): string {
  if (!timeoutSeconds) {
    return "Watchdog: off";
  }

  const state = snapshot?.timedOut
    ? "timed out"
    : snapshot?.active
      ? "active"
      : snapshot?.stopped
        ? "stopped"
        : "configured";
  const remaining = snapshot?.remainingMs !== null && snapshot?.remainingMs !== undefined
    ? `, remaining=${Math.ceil(snapshot.remainingMs / 1000)}s`
    : "";
  const lastLabel = snapshot?.lastLabel ? `, last=${snapshot.lastLabel}` : "";
  return `Watchdog: ${state}, timeout=${timeoutSeconds}s${remaining}${lastLabel}`;
}

function formatParallelAgentStatus(record: ParallelAgentTaskRecord): string {
  const progress = record.progress;
  return [
    `id: ${record.id}`,
    `status: ${record.status}`,
    `description: ${record.description ?? "(none)"}`,
    `provider: ${record.provider}${record.model ? `/${record.model}` : ""}`,
    `created: ${record.createdAt}`,
    record.startedAt ? `started: ${record.startedAt}` : undefined,
    record.finishedAt ? `finished: ${record.finishedAt}` : undefined,
    record.lastActivity ? `last_activity: ${record.lastActivity}` : undefined,
    progress ? `progress: tools=${progress.toolUseCount}${progress.lastTool ? ` last_tool=${progress.lastTool}` : ""}${progress.messageCount !== undefined ? ` messages=${progress.messageCount}` : ""}${progress.tokenCount !== undefined ? ` tokens=${progress.tokenCount}` : ""}` : undefined,
    record.summary ? `summary: ${record.summary}` : undefined,
    record.error ? `error: ${record.error}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function parallelAgentIdFromData(data: unknown): string {
  if (data && typeof data === "object" && "id" in data) {
    const id = (data as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  }
  return "";
}

function parseSkillIdList(value: string): BuiltInSkillId[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => assertBuiltInSkillId(id));
}

function formatSkillStatus(explicitSkillIds: BuiltInSkillId[], autoSkillsEnabled: boolean): string {
  return [
    `Auto skills: ${autoSkillsEnabled ? "on" : "off"}`,
    `Explicit skills: ${explicitSkillIds.length ? explicitSkillIds.join(", ") : "(none)"}`,
  ].join("\n");
}

type PlanRunReadModelContext = {
  lastVerificationSummary?: string;
  lastFailureClass?: PlanRunFailureClass;
  lastFailureReason?: string;
  lastRecoveryRationale?: string;
};

type PlanRunFailureClass = "blocked" | "needs_user" | "failed" | "aborted";

function asPlanRunContext(record: PlanRunRecord): PlanRunReadModelContext {
  const extra = record as PlanRunRecord & PlanRunReadModelContext;
  return {
    lastVerificationSummary: extra.lastVerificationSummary,
    lastFailureClass: extra.lastFailureClass,
    lastFailureReason: extra.lastFailureReason,
    lastRecoveryRationale: extra.lastRecoveryRationale,
  };
}

function humanizeRecoveryAction(action?: string): string | undefined {
  switch (action) {
    case "retry":
      return "retry the task";
    case "replan":
      return "replan the remaining work";
    case "ask-user":
      return "ask the user for clarification";
    case "stop":
      return "stop and mark the run incomplete";
    default:
      return undefined;
  }
}

function summarizeVerificationForReadModel(record: PlanRunRecord): string | undefined {
  const context = asPlanRunContext(record);
  if (context.lastVerificationSummary?.trim()) {
    return context.lastVerificationSummary.trim();
  }

  const latestVerifiedStep = [...record.steps].reverse().find((step) => step.task.verification?.summary?.trim());
  if (latestVerifiedStep?.task.verification?.summary?.trim()) {
    return latestVerifiedStep.task.verification.summary.trim();
  }

  const latestStep = [...record.steps].reverse().find((step) => step.result !== undefined || step.evaluation !== undefined);
  if (latestStep?.task.verification?.summary?.trim()) {
    return latestStep.task.verification.summary.trim();
  }

  const summarized = summarizePlanStepResult(latestStep?.result);
  if (summarized) {
    return summarized;
  }

  if (latestStep?.evaluation?.reason?.trim()) {
    return latestStep.evaluation.reason.trim();
  }

  return undefined;
}

function summarizeFailureClassForReadModel(record: PlanRunRecord): PlanRunFailureClass | undefined {
  const context = asPlanRunContext(record);
  if (context.lastFailureClass?.trim()) {
    return context.lastFailureClass.trim() as PlanRunFailureClass;
  }

  const failingStep = [...record.steps].reverse().find(
    (step) => step.task.status === "blocked"
      || step.task.status === "needs_user"
      || step.task.status === "failed"
      || step.task.status === "aborted",
  );

  return (failingStep?.task.status as PlanRunFailureClass | undefined) ?? (
    record.status === "blocked"
      || record.status === "needs_user"
      || record.status === "failed"
      || record.status === "aborted"
      ? record.status
      : undefined
  );
}

function summarizeFailureReasonForReadModel(record: PlanRunRecord): string | undefined {
  const context = asPlanRunContext(record);
  if (context.lastFailureReason?.trim()) {
    return context.lastFailureReason.trim();
  }

  const failingStep = [...record.steps].reverse().find(
    (step) => step.task.failureReason?.trim()
      || step.task.recovery?.reason?.trim()
      || step.task.nextAction?.trim()
      || step.evaluation?.reason?.trim(),
  );

  return failingStep?.task.failureReason?.trim()
    ?? failingStep?.task.recovery?.reason?.trim()
    ?? failingStep?.task.nextAction?.trim()
    ?? failingStep?.evaluation?.reason?.trim();
}

function summarizeRecoveryRationaleForReadModel(record: PlanRunRecord): string | undefined {
  const context = asPlanRunContext(record);
  if (context.lastRecoveryRationale?.trim()) {
    return context.lastRecoveryRationale.trim();
  }

  const latestStep = [...record.steps].reverse().find(
    (step) => step.task.recovery?.reason?.trim() || step.task.recovery?.action,
  );

  return latestStep?.task.recovery?.reason?.trim()
    ?? humanizeRecoveryAction(latestStep?.task.recovery?.action)
    ?? latestStep?.task.nextAction?.trim();
}

function summarizePlanRunContext(record: PlanRunRecord): PlanRunReadModelContext {
  return {
    lastVerificationSummary: summarizeVerificationForReadModel(record),
    lastFailureClass: summarizeFailureClassForReadModel(record),
    lastFailureReason: summarizeFailureReasonForReadModel(record),
    lastRecoveryRationale: summarizeRecoveryRationaleForReadModel(record),
  };
}

function toSortableTime(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function isGoalRunResumable(record: PlanRunRecord): boolean {
  return (
    (record.mode === "goal" || record.mode === "autopilot")
    && record.resumeEligible !== false
    && (
      record.status === "running"
      || record.status === "failed"
      || record.status === "aborted"
      || record.status === "blocked"
      || record.status === "needs_user"
    )
  );
}

export function findLatestResumableGoalRun(planRuns: PlanRunRecord[]): PlanRunRecord | null {
  const candidates = planRuns
    .filter(isGoalRunResumable)
    .sort((a, b) => toSortableTime(b.createdAt) - toSortableTime(a.createdAt));

  return candidates[0] ?? null;
}

export function formatGoalResumeLines(record: PlanRunRecord): string[] {
  const lines: string[] = [];
  const summary = record.summary ?? { completed: 0, failed: 0, ambiguous: 0, verified: 0 };
  const status = record.status ?? (record.completed ? "completed" : "running");
  const label = record.mode === "autopilot" ? "Autopilot" : "Goal";

  lines.push(`${label}: ${record.goal}`);
  lines.push(`Status: ${status} (completed=${summary.completed}, failed=${summary.failed}, verified=${summary.verified ?? 0}, ambiguous=${summary.ambiguous})`);
  if (record.mode === "autopilot" && typeof record.cycleCount === "number") {
    lines.push(`Cycles: ${record.cycleCount}`);
  }
  if (record.stopReason?.trim()) {
    lines.push(`Stop reason: ${record.stopReason.trim()}`);
  }

  const context = summarizePlanRunContext(record);
  if (context.lastVerificationSummary) {
    lines.push(`Last verification: ${context.lastVerificationSummary}`);
  }
  if (context.lastFailureClass) {
    lines.push(`Failure class: ${context.lastFailureClass}`);
  }
  if (context.lastFailureReason) {
    lines.push(`Failure reason: ${context.lastFailureReason}`);
  }
  if (context.lastRecoveryRationale) {
    lines.push(`Recovery rationale: ${context.lastRecoveryRationale}`);
  }

  if (record.activeTaskId) {
    lines.push(`Active task: ${record.activeTaskId}`);
  }
  if (record.nextAction?.trim()) {
    lines.push(`Next action: ${record.nextAction.trim()}`);
  }
  if (record.recoveryAction) {
    lines.push(`Recovery: ${record.recoveryAction}`);
  }

  lines.push(`Resume hint: /${record.mode === "autopilot" ? "autopilot" : "goal"} ${record.goal}`);
  return lines;
}

function getPlanRunHeading(record: PlanRunRecord): string {
  const kind = record.mode === "autopilot" ? "Autopilot" : record.mode === "goal" ? "Goal" : "Plan";
  const status = record.status ?? (record.completed ? "completed" : "running");

  switch (status) {
    case "running":
      return `${kind} (running)`;
    case "blocked":
      return `${kind} (blocked)`;
    case "needs_user":
      return `${kind} (needs user)`;
    case "failed":
      return `${kind} (failed)`;
    case "aborted":
      return `${kind} (aborted)`;
    default:
      return kind;
  }
}

function buildAssistantDisplayMessage(content: ChatMessage["content"]): DisplayMessage {
  if (typeof content === "string") {
    return { role: "assistant", text: content };
  }

  const toolCalls: ToolCallDisplay[] = [];
  const toolCallIndex = new Map<string, number>();
  let text = "";

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
      continue;
    }

    if (block.type === "tool_use") {
      const toolCall: ToolCallDisplay = {
        toolUseId: block.id,
        toolName: block.name,
        input: block.input,
        status: "running",
      };
      toolCallIndex.set(block.id, toolCalls.length);
      toolCalls.push(toolCall);
      continue;
    }

    if (block.type === "tool_result") {
      const existingIndex = toolCallIndex.get(block.toolUseId);
      if (existingIndex !== undefined) {
        toolCalls[existingIndex] = {
          ...toolCalls[existingIndex]!,
          result: block.content,
          isError: block.isError,
          status: "done",
        };
      } else {
        toolCallIndex.set(block.toolUseId, toolCalls.length);
        toolCalls.push({
          toolUseId: block.toolUseId,
          toolName: "Tool",
          input: {},
          result: block.content,
          isError: block.isError,
          status: "done",
        });
      }
    }
  }

  return {
    role: "assistant",
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export function buildDisplayMessagesFromMessages(messages: ChatMessage[]): DisplayMessage[] {
  const displayMessages: DisplayMessage[] = [];
  let lastMessageWasToolResultOnlyUser = false;

  for (const message of messages) {
    if (isToolResultOnlyUserMessage(message)) {
      const lastDisplayMessage = displayMessages[displayMessages.length - 1];
      if (lastDisplayMessage?.role === "assistant") {
        const mergedAssistant = buildAssistantDisplayMessage(message.content);
        const existingToolCalls = lastDisplayMessage.toolCalls ?? [];
        const toolCallIndex = new Map(existingToolCalls.map((toolCall, index) => [toolCall.toolUseId, index]));
        const nextToolCalls = [...existingToolCalls];

        for (const toolCall of mergedAssistant.toolCalls ?? []) {
          const existingIndex = toolCallIndex.get(toolCall.toolUseId);
          if (existingIndex !== undefined) {
            nextToolCalls[existingIndex] = {
              ...nextToolCalls[existingIndex]!,
              result: toolCall.result,
              isError: toolCall.isError,
              status: toolCall.status,
            };
          } else {
            nextToolCalls.push(toolCall);
          }
        }

        displayMessages[displayMessages.length - 1] = {
          ...lastDisplayMessage,
          toolCalls: nextToolCalls.length > 0 ? nextToolCalls : undefined,
        };
      }

      lastMessageWasToolResultOnlyUser = true;
      continue;
    }

    if (message.role === "user") {
      displayMessages.push({
        role: "user",
        text: contentToText(message.content),
      });
      lastMessageWasToolResultOnlyUser = false;
      continue;
    }

    if (message.role === "assistant") {
      const assistantMessage = buildAssistantDisplayMessage(message.content);
      const lastDisplayMessage = displayMessages[displayMessages.length - 1];

      if (
        lastMessageWasToolResultOnlyUser &&
        lastDisplayMessage?.role === "assistant" &&
        !assistantMessage.toolCalls?.length
      ) {
        const needsSeparator = Boolean(
          lastDisplayMessage.text &&
          assistantMessage.text &&
          !assistantMessage.text.startsWith("\n"),
        );
        displayMessages[displayMessages.length - 1] = {
          ...lastDisplayMessage,
          text: `${lastDisplayMessage.text}${needsSeparator ? "\n" : ""}${assistantMessage.text}`.trim(),
        };
      } else {
        displayMessages.push(assistantMessage);
      }

      lastMessageWasToolResultOnlyUser = false;
    }
  }

  return displayMessages;
}

function summarizePlanStepResult(result: unknown): string {
  const normalized = summarizeTaskResult(result);
  if (normalized) {
    return summarizePromptForDisplay(normalized);
  }

  if (typeof result === "string") {
    return summarizePromptForDisplay(result);
  }

  if (!result || typeof result !== "object") {
    return "";
  }

  const rec = result as Record<string, unknown>;
  const keys = ["finalText", "summary", "message", "output", "result", "reason", "error"];
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return summarizePromptForDisplay(value);
    }
  }

  try {
    return summarizePromptForDisplay(JSON.stringify(result));
  } catch {
    return "";
  }
}

function getPlanStepMarker(task: PlanStepRecord["task"], evaluation?: EvaluationResult): string {
  if (task.status === "running") return "⟳";
  if (task.status === "needs_user") return "!";
  if (task.status === "blocked") return "⧖";
  if (task.status === "failed") return "✗";
  if (evaluation?.outcome === "ambiguous") return "?";
  if (task.status === "completed" || task.status === "verified") return "✓";
  return "•";
}

function derivePlanRunStatus(result: PlanExecutionResult, error?: string): PlanRunStatus {
  if (error) return "failed";
  if (result.plan.tasks.some((task) => task.status === "needs_user")) return "needs_user";
  if (result.plan.tasks.some((task) => task.status === "blocked")) return "blocked";
  if (result.plan.tasks.some((task) => task.status === "aborted")) return "aborted";
  if (result.completed) return "completed";
  if (result.plan.tasks.some((task) => task.status === "failed")) return "failed";
  return "running";
}

export function formatPlanRunLines(record: PlanRunRecord): string[] {
  const lines: string[] = [];
  lines.push(`${getPlanRunHeading(record)}: ${record.goal}`);

  if (record.providerName || record.model) {
    lines.push(`Provider: ${record.providerName ?? "(unknown)"}${record.model ? ` / ${record.model}` : ""}`);
  }

  const summary = record.summary ?? { completed: 0, failed: 0, ambiguous: 0, verified: 0 };
  const status = record.status ?? (record.completed ? "completed" : "running");
  lines.push(`Status: ${status} (completed=${summary.completed}, failed=${summary.failed}, verified=${summary.verified ?? 0}, ambiguous=${summary.ambiguous})`);
  if (record.mode === "autopilot" && typeof record.cycleCount === "number") {
    lines.push(`Cycles: ${record.cycleCount}`);
  }
  if (record.stopReason?.trim()) {
    lines.push(`Stop reason: ${record.stopReason.trim()}`);
  }

  const context = summarizePlanRunContext(record);
  if (context.lastVerificationSummary) {
    lines.push(`Last verification: ${context.lastVerificationSummary}`);
  }
  if (context.lastFailureClass) {
    lines.push(`Failure class: ${context.lastFailureClass}`);
  }
  if (context.lastFailureReason) {
    lines.push(`Failure reason: ${context.lastFailureReason}`);
  }
  if (context.lastRecoveryRationale) {
    lines.push(`Recovery rationale: ${context.lastRecoveryRationale}`);
  }
  if (record.decisionLog && record.decisionLog.length > 0) {
    lines.push("Recent decisions:");
    for (const decision of record.decisionLog.slice(-5)) {
      lines.push(`  - cycle ${decision.cycle}: ${decision.kind} — ${decision.reason}`);
    }
  }

  lines.push("Steps:");

  for (const step of record.steps) {
    const marker = getPlanStepMarker(step.task, step.evaluation);
    const resultText = step.output?.summary?.trim() ?? summarizePlanStepResult(step.result);
    const outcome = step.evaluation?.outcome;
    const suffix = resultText ? ` — ${resultText}` : "";
    const outcomeSuffix = outcome === "ambiguous" ? " (ambiguous)" : "";
    lines.push(`  ${marker} ${step.task.id}: ${step.task.description}${outcomeSuffix}${suffix}`);
  }

  if (record.resultText?.trim()) {
    lines.push("Result:");
    for (const line of record.resultText.trim().split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (record.error?.trim()) {
    lines.push(`Error: ${record.error.trim()}`);
  }

  return lines;
}

function PlanRunPanel({ run }: { run: PlanRunRecord }) {
  const lines = formatPlanRunLines(run);
  const borderColor = run.status === "failed"
    ? "red"
    : run.status === "running" || run.status === "blocked" || run.status === "needs_user"
      ? "yellow"
      : "gray";

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1} borderStyle="single" borderColor={borderColor}>
      <Box marginBottom={1}>
        <Text color="blue" bold>{getPlanRunHeading(run)}</Text>
      </Box>
      {lines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
}

function clonePlanRun(run: PlanRunRecord): PlanRunRecord {
  return {
    ...run,
    decisionLog: run.decisionLog ? run.decisionLog.map((entry) => ({ ...entry })) : undefined,
    plan: {
      goal: run.plan.goal,
      tasks: run.plan.tasks.map((task) => ({
        ...task,
        dependsOn: [...task.dependsOn],
      })),
    },
    steps: run.steps.map((step) => ({
      task: {
        ...step.task,
        dependsOn: [...step.task.dependsOn],
      },
      result: step.result,
      evaluation: step.evaluation ? { ...step.evaluation } : undefined,
    })),
    summary: run.summary ? { ...run.summary } : undefined,
  };
}

function summarizePlanRun(run: PlanRunRecord): NonNullable<PlanRunRecord["summary"]> {
  return {
    completed: run.plan.tasks.filter((task) => task.status === "completed").length,
    failed: run.plan.tasks.filter((task) => task.status === "failed").length,
    ambiguous: run.steps.filter((step) => step.evaluation?.outcome === "ambiguous").length,
    verified: run.plan.tasks.filter((task) => task.status === "verified").length,
  };
}

function upsertPlanRun(runs: PlanRunRecord[], nextRun: PlanRunRecord): PlanRunRecord[] {
  const index = runs.findIndex((run) => run.planRunId === nextRun.planRunId);
  if (index === -1) return [...runs, nextRun];
  const next = [...runs];
  next[index] = nextRun;
  return next;
}

function findNextRunnableTaskId(run: PlanRunRecord): string | undefined {
  return run.plan.tasks.find((task) => task.status !== "completed" && task.status !== "verified")?.id;
}

function updatePlanRunStep(
  run: PlanRunRecord,
  taskId: string,
  patch: Partial<PlanStepRecord> & {
    taskStatus?: Task["status"];
    status?: PlanRunRecord["status"];
    nextAction?: string;
    recoveryAction?: PlanRunRecord["recoveryAction"];
    completed?: boolean;
    resumeEligible?: boolean;
    lastVerificationSummary?: string;
    lastFailureClass?: PlanRunFailureClass;
    lastFailureReason?: string;
    lastRecoveryRationale?: string;
    cycleCount?: number;
    stopReason?: string;
  },
): PlanRunRecord {
  const next = clonePlanRun(run);
  const taskIndex = next.plan.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex !== -1) {
    next.plan.tasks[taskIndex] = {
      ...next.plan.tasks[taskIndex]!,
      status: patch.taskStatus ?? next.plan.tasks[taskIndex]!.status,
    };
  }

  const stepIndex = next.steps.findIndex((step) => step.task.id === taskId);

  if (stepIndex === -1) {
    next.steps.push({
      task: {
        id: taskId,
        description: taskId,
        dependsOn: [],
        status: patch.taskStatus ?? "pending",
      },
      result: patch.result,
      output: patch.output,
      evaluation: patch.evaluation,
    });
    next.activeTaskId = findNextRunnableTaskId(next);
    next.summary = summarizePlanRun(next);
    next.status = patch.status ?? next.status;
    next.nextAction = patch.nextAction ?? next.nextAction;
    next.recoveryAction = patch.recoveryAction ?? next.recoveryAction;
    next.completed = patch.completed ?? next.completed;
    next.resumeEligible = patch.resumeEligible ?? next.resumeEligible;
    next.lastVerificationSummary = patch.lastVerificationSummary ?? next.lastVerificationSummary;
    next.lastFailureClass = patch.lastFailureClass ?? next.lastFailureClass;
    next.lastFailureReason = patch.lastFailureReason ?? next.lastFailureReason;
    next.lastRecoveryRationale = patch.lastRecoveryRationale ?? next.lastRecoveryRationale;
    next.cycleCount = patch.cycleCount ?? next.cycleCount;
    next.stopReason = patch.stopReason ?? next.stopReason;
    return next;
  }

  const current = next.steps[stepIndex]!;
  next.steps[stepIndex] = {
    task: {
      ...current.task,
      status: patch.taskStatus ?? current.task.status,
    },
    result: patch.result ?? current.result,
    output: patch.output ?? current.output,
    evaluation: patch.evaluation ?? current.evaluation,
  };

  next.activeTaskId = findNextRunnableTaskId(next);
  next.summary = summarizePlanRun(next);
  next.status = patch.status ?? next.status;
  next.nextAction = patch.nextAction ?? next.nextAction;
  next.recoveryAction = patch.recoveryAction ?? next.recoveryAction;
  next.completed = patch.completed ?? next.completed;
  next.resumeEligible = patch.resumeEligible ?? next.resumeEligible;
  next.lastVerificationSummary = patch.lastVerificationSummary ?? next.lastVerificationSummary;
  next.lastFailureClass = patch.lastFailureClass ?? next.lastFailureClass;
  next.lastFailureReason = patch.lastFailureReason ?? next.lastFailureReason;
  next.lastRecoveryRationale = patch.lastRecoveryRationale ?? next.lastRecoveryRationale;
  next.cycleCount = patch.cycleCount ?? next.cycleCount;
  next.stopReason = patch.stopReason ?? next.stopReason;
  return next;
}

function createPlanRunRecordFromResult(
  sessionId: string,
  result: PlanExecutionResult,
  details: {
    goal: string;
    prompt: string;
    providerName?: string;
    model?: string;
    source?: "cli" | "tui";
    cwd?: string;
    error?: string;
    mode?: PlanRunMode;
    cycleCount?: number;
    decisionLog?: PlanRunRecord["decisionLog"];
    stopReason?: string;
  },
): PlanRunRecord {
  const mode = details.mode ?? "plan";
  const lastStep = [...result.steps].reverse().find((step) => step.task.status !== "pending" || step.result !== undefined || step.evaluation !== undefined);
  const runContext: PlanRunReadModelContext = {
    lastVerificationSummary: lastStep?.task.verification?.summary?.trim()
      ?? summarizePlanStepResult(lastStep?.result)
      ?? lastStep?.evaluation?.reason?.trim(),
    lastFailureClass: lastStep?.task.status === "blocked"
      || lastStep?.task.status === "needs_user"
      || lastStep?.task.status === "failed"
      || lastStep?.task.status === "aborted"
      ? lastStep.task.status
      : undefined,
    lastFailureReason: lastStep?.task.failureReason?.trim()
      ?? lastStep?.task.recovery?.reason?.trim()
      ?? lastStep?.task.nextAction?.trim()
      ?? lastStep?.evaluation?.reason?.trim(),
    lastRecoveryRationale: lastStep?.task.recovery?.reason?.trim()
      ?? humanizeRecoveryAction(lastStep?.task.recovery?.action)
      ?? lastStep?.task.nextAction?.trim(),
  };
  return {
    _type: "plan_run",
    planRunId: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    mode: mode === "goal" || mode === "autopilot" ? mode : undefined,
    resumeEligible: mode === "goal" || mode === "autopilot" ? true : undefined,
    source: details.source ?? "tui",
    cwd: details.cwd,
    providerName: details.providerName,
    model: details.model,
    prompt: details.prompt,
    goal: result.plan.goal || details.goal,
    plan: {
      goal: result.plan.goal,
      tasks: result.plan.tasks.map((task) => ({
        ...task,
        dependsOn: [...task.dependsOn],
      })),
    },
    steps: result.steps.map((step) => ({
      task: {
        ...step.task,
        dependsOn: [...step.task.dependsOn],
      },
      result: step.result,
      output: step.output
        ? {
            ...step.output,
            artifacts: step.output.artifacts ? step.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
          }
        : undefined,
      evaluation: { ...step.evaluation },
    })),
    summary: { ...result.summary },
    cycleCount: details.cycleCount,
    decisionLog: details.decisionLog ? details.decisionLog.map((entry) => ({ ...entry })) : undefined,
    stopReason: details.stopReason,
    completed: result.completed,
    status: derivePlanRunStatus(result, details.error),
    ...runContext,
    resultText: formatPlanRunLines({
      _type: "plan_run",
      planRunId: "preview",
      sessionId,
      createdAt: new Date().toISOString(),
      source: details.source ?? "tui",
      cwd: details.cwd,
      providerName: details.providerName,
      model: details.model,
      prompt: details.prompt,
      goal: result.plan.goal || details.goal,
      plan: {
        goal: result.plan.goal,
        tasks: result.plan.tasks,
      },
      steps: result.steps,
      summary: result.summary,
      completed: result.completed,
      status: derivePlanRunStatus(result, details.error),
      ...runContext,
      error: details.error,
    }).join("\n"),
    error: details.error,
  };
}

// ---------------------------------------------------------------------------
// REPL Component
// ---------------------------------------------------------------------------

export interface REPLProps {
  state: AppState;
  providerRegistry?: ProviderRegistry;
  systemPrompt: string;
  maxTurns: number;
  session?: SessionManager;
  showReasoning?: boolean;
  mcpStatus?: string;
  proxyStatus?: ProxyStatus;
  statusTracker?: StatusTracker;
  initialRole?: Role;
  initialExplicitSkillIds?: BuiltInSkillId[];
  initialAutoSkillsEnabled?: boolean;
}

function reloadProviderRegistry(
  fallback?: ProviderRegistry,
  defaultProviderName?: string,
): ProviderRegistry | undefined {
  const { configs, defaultName } = loadProviders();
  if (configs.length === 0) {
    return fallback;
  }
  return new ProviderRegistryImpl(configs, defaultProviderName ?? defaultName);
}

export function REPL({
  state,
  providerRegistry,
  systemPrompt,
  maxTurns,
  session,
  showReasoning = true,
  mcpStatus,
  proxyStatus,
  statusTracker,
  initialRole,
  initialExplicitSkillIds = [],
  initialAutoSkillsEnabled = true,
}: REPLProps) {
  const { exit } = useApp();
  const settings = React.useMemo(() => loadSettings(), []);
  const [runtimeTweaks] = useState(() => new RuntimeTweaks({
    defaults: {
      maxTurns,
      autoSummary: true,
      showReasoning,
    },
  }));
  const [runtimeTweaksSnapshot, setRuntimeTweaksSnapshot] = useState(() => runtimeTweaks.snapshot());
  const [snipRegistry] = useState(() => new SnipRegistry());
  const runtimeValues = runtimeTweaksSnapshot.values;
  state.saveSubAgentRun = session ? (record) => session.saveSubAgentRun(record) : undefined;

  // State — provider tracked via useState for React re-renders (H4)
  const [runtimeProviderRegistry, setRuntimeProviderRegistry] = useState<ProviderRegistry | undefined>(providerRegistry);
  const [currentProvider, setCurrentProvider] = useState<LLMProvider>(state.provider);
  const [sessionMessages] = useState<ChatMessage[]>(() => session?.loadMessages() ?? []);
  const [messages, setMessages] = useState<ChatMessage[]>(sessionMessages);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(
    () => buildDisplayMessagesFromMessages(sessionMessages),
  );
  const [planRuns, setPlanRuns] = useState<PlanRunRecord[]>(() => session?.loadPlanRuns() ?? []);
  const [activePlanRun, setActivePlanRun] = useState<PlanRunRecord | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [reasoningText, setReasoningText] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallDisplay[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<Pick<AgentStatusSnapshot, "status" | "mode"> | undefined>(() => statusTracker?.get());
  const [turnCount, setTurnCount] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [showProviderSwitcher, setShowProviderSwitcher] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<Role | undefined>(initialRole);
  const [explicitSkillIds, setExplicitSkillIds] = useState<BuiltInSkillId[]>(initialExplicitSkillIds);
  const [autoSkillsEnabled, setAutoSkillsEnabled] = useState(initialAutoSkillsEnabled);
  const [promptInsert, setPromptInsert] = useState<{ text: string; key: number } | null>(null);
  const [watchdogTimeoutSeconds, setWatchdogTimeoutSeconds] = useState<number | undefined>();
  const [watchdogSnapshot, setWatchdogSnapshot] = useState<WatchdogSnapshot | null>(null);
  const latestGoalRun = React.useMemo(
    () => findLatestResumableGoalRun(activePlanRun ? [...planRuns, activePlanRun] : planRuns),
    [activePlanRun, planRuns],
  );

  // Pending permission prompt — set when agent loop yields permission_ask
  const [pendingPermission, setPendingPermission] = useState<{
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    reason: string;
    resolve: (allowed: boolean) => void;
  } | null>(null);

  const [pendingQuestion, setPendingQuestion] = useState<{
    questions: AskUserQuestionQuestion[];
    resolve: (response: AskUserQuestionResponse) => void;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const requestPermission = useCallback(
    (toolUseId: string, toolName: string, input: Record<string, unknown>, reason: string) =>
      new Promise<boolean>((resolve) => {
        setPendingPermission({
          toolUseId,
          toolName,
          input,
          reason,
          resolve: (allowed: boolean) => {
            setPendingPermission(null);
            resolve(allowed);
          },
        });
      }),
    [],
  );

  const requestUserQuestion = useCallback<AskUserQuestionHandler>(
    (request) =>
      new Promise<AskUserQuestionResponse>((resolve) => {
        setPendingQuestion({
          questions: request.questions.map((question) => ({
            question: question.question,
            options: question.options.map((option) => ({ ...option })),
          })),
          resolve: (response) => {
            setPendingQuestion(null);
            resolve(response);
          },
        });
      }),
    [],
  );

  React.useEffect(() => {
    state.askUserQuestion = requestUserQuestion;
    return () => {
      if (state.askUserQuestion === requestUserQuestion) {
        state.askUserQuestion = undefined;
      }
    };
  }, [requestUserQuestion, state]);

  const updateAgentStatus = useCallback(
    (status: AgentStatus, metadata: { mode?: AgentStatusSnapshot["mode"]; message?: string; turn?: number } = {}) => {
      const snapshot = statusTracker?.update(status, {
        mode: metadata.mode ?? "chat",
        sessionId: session?.sessionId,
        provider: currentProvider.name,
        model: currentProvider.model,
        turn: metadata.turn,
        cwd: state.cwd,
        message: metadata.message,
      });
      setAgentStatus(snapshot ?? { status, mode: metadata.mode ?? "chat" });
    },
    [currentProvider.model, currentProvider.name, session, state.cwd, statusTracker],
  );

  const currentSystemPrompt = React.useMemo(
    () => buildSystemPrompt(state.cwd, [...state.tools.values()], state.projectMemory, currentProvider, activeRole),
    [state, currentProvider, activeRole],
  );

  function formatCompletedOutputsForPrompt(execution: PlanExecutionContext): string | null {
    const lines: string[] = [];
    for (const [taskId, output] of execution.completedOutputs.entries()) {
      const summary = output.summary?.trim() || output.verificationSummary?.trim();
      if (summary) {
        lines.push(`- ${taskId}: ${summary}`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  const runPlannedTaskInTui = useCallback(
    async (
      goal: string,
      taskDescription: string,
      execution: PlanExecutionContext,
    ): Promise<{ success: boolean; finalText: string; message?: string }> => {
      const previousOutputs = formatCompletedOutputsForPrompt(execution);
      const taskMessages = [
        {
          role: "user" as const,
          content: [
            "You are executing one step of a larger plan.",
            `Overall goal: ${goal}`,
            `Current task: ${taskDescription}`,
            previousOutputs ? `Completed task outputs:\n${previousOutputs}` : "",
            "Use tools if needed and finish with a concise result for this step.",
          ].join("\n"),
        },
      ];

      const loop = agentLoop({
        state,
        messages: taskMessages,
        systemPrompt: currentSystemPrompt,
        maxTurns: runtimeValues.maxTurns,
        temperature: runtimeValues.temperature,
        maxResultChars: runtimeValues.maxResultChars,
        autoSummary: runtimeValues.autoSummary,
        snipRegistry,
      });

      let finalText = "";
      let failedMessage: string | undefined;

      for await (const event of loopIterable(loop)) {
        switch (event.type) {
          case "text_delta":
            finalText += event.text;
            break;
          case "reasoning_delta":
            break;
          case "permission_ask": {
            const allowed = await requestPermission(
              event.toolUseId,
              event.toolName,
              event.input,
              `Tool "${event.toolName}" requires confirmation`,
            );
            event.resolve(allowed);
            break;
          }
          case "error":
            failedMessage = event.error.message;
            break;
          case "warning":
            break;
        }
      }

      if (failedMessage) {
        return {
          success: false,
          finalText,
          message: failedMessage,
        };
      }

      return {
        success: finalText.trim().length > 0,
        finalText,
      };
    },
    [currentSystemPrompt, requestPermission, runtimeValues, snipRegistry, state],
  );

  const runPlanMode = useCallback(
    async (
      goalPrompt: string,
      displayPrompt: string,
      mode: PlanRunMode = "plan",
      resumeFrom?: PlanRunRecord | null,
    ) => {
      const resumableMode = mode === "goal" || mode === "autopilot";
      setStreamingText("");
      setReasoningText("");
      setActiveToolCalls([]);
      setIsLoading(true);
      updateAgentStatus("planning", { mode, message: mode === "autopilot" ? "starting autopilot" : "building plan" });
      const ac = new AbortController();
      abortRef.current = ac;
      state.abortController = ac;
      let initialPlanRun: PlanRunRecord | null = null;
      let latestPlanRunSnapshot: PlanRunRecord | null = null;

      try {
        const plan = resumeFrom
          ? {
              goal: resumeFrom.plan.goal,
              tasks: resumeFrom.plan.tasks.map((task) => ({
                ...task,
                dependsOn: [...task.dependsOn],
              })),
            }
          : await buildPlan(goalPrompt, state);
        initialPlanRun = resumeFrom
          ? {
              ...clonePlanRun(resumeFrom),
              createdAt: new Date().toISOString(),
              source: "tui",
              cwd: state.cwd,
              providerName: currentProvider.name,
              model: currentProvider.model,
              prompt: displayPrompt,
              goal: plan.goal,
              status: "running",
              completed: false,
              error: undefined,
              resumeEligible: true,
            }
          : {
              _type: "plan_run",
              planRunId: randomUUID(),
              sessionId: session?.sessionId ?? "tui-session",
              createdAt: new Date().toISOString(),
              source: "tui",
              cwd: state.cwd,
              providerName: currentProvider.name,
              model: currentProvider.model,
              prompt: displayPrompt,
              goal: plan.goal,
              mode: resumableMode ? mode : undefined,
              resumeEligible: resumableMode ? true : undefined,
              activeTaskId: plan.tasks[0]?.id,
              nextAction: plan.tasks[0]?.id ? "start" : undefined,
              plan: {
                goal: plan.goal,
                tasks: plan.tasks.map((task) => ({
                  ...task,
                  dependsOn: [...task.dependsOn],
                })),
              },
              steps: [],
              summary: { completed: 0, failed: 0, ambiguous: 0, verified: 0 },
              completed: false,
              status: "running",
            };

        setActivePlanRun(initialPlanRun);
        latestPlanRunSnapshot = initialPlanRun;
        if (resumableMode) {
          session?.savePlanRun(initialPlanRun);
          setPlanRuns((prev) => upsertPlanRun(prev, initialPlanRun!));
        }
        const executionOptions = {
          runTask: async (task: Task, _context: AppState, execution: PlanExecutionContext) => runPlannedTaskInTui(goalPrompt, task.description, execution),
          onTaskStart: (task: Task) => {
            updateAgentStatus("running", { mode, message: task.description });
            setActivePlanRun((prev) => {
              if (!prev) return prev;
              const next = updatePlanRunStep(prev, task.id, {
                taskStatus: "running",
                status: "running",
                nextAction: "run",
                resumeEligible: resumableMode,
              });
              latestPlanRunSnapshot = next;
              if (resumableMode) {
                session?.savePlanRun(next);
                setPlanRuns((runs) => upsertPlanRun(runs, next));
              }
              return next;
            });
          },
          onTaskEnd: (step: PlanExecutionStep) => {
            setActivePlanRun((prev) => {
              if (!prev) return prev;
              const next = updatePlanRunStep(prev, step.task.id, {
                taskStatus: step.task.status,
                result: step.result,
                output: step.output,
                evaluation: step.evaluation,
                status: step.task.status === "needs_user"
                  ? "needs_user"
                  : step.task.status === "blocked"
                    ? "blocked"
                    : prev.status,
                nextAction: step.task.nextAction,
                recoveryAction: step.task.recovery?.action,
                resumeEligible: resumableMode,
                lastVerificationSummary: summarizeVerificationForReadModel({
                  ...prev,
                  steps: [
                    ...prev.steps.filter((existingStep) => existingStep.task.id !== step.task.id),
                    step,
                  ],
                }),
    lastFailureClass: step.task.status === "blocked"
      || step.task.status === "needs_user"
      || step.task.status === "failed"
      || step.task.status === "aborted"
      ? (step.task.status as PlanRunFailureClass)
      : undefined,
                lastFailureReason: step.task.failureReason?.trim()
                  ?? step.task.recovery?.reason?.trim()
                  ?? step.task.nextAction?.trim()
                  ?? step.evaluation?.reason?.trim(),
                lastRecoveryRationale: step.task.recovery?.reason?.trim()
                  ?? humanizeRecoveryAction(step.task.recovery?.action)
                  ?? step.task.nextAction?.trim(),
              });
              latestPlanRunSnapshot = next;
              if (resumableMode) {
                session?.savePlanRun(next);
                setPlanRuns((runs) => upsertPlanRun(runs, next));
              }
              return next;
            });
          },
        };

        const result = mode === "autopilot"
          ? await runAutopilot(goalPrompt, state, {
              ...executionOptions,
              planner: {
                async plan(goalText, planState) {
                  if (goalText === goalPrompt && !resumeFrom) {
                    return {
                      goal: plan.goal,
                      tasks: plan.tasks.map((task) => ({
                        ...task,
                        dependsOn: [...task.dependsOn],
                      })),
                    };
                  }
                  return buildPlan(goalText, planState);
                },
              },
              resumeState: resumeFrom?.mode === "autopilot"
                ? {
                    plan: {
                      goal: resumeFrom.plan.goal,
                      tasks: resumeFrom.plan.tasks.map((task) => ({
                        ...task,
                        dependsOn: [...task.dependsOn],
                      })),
                    },
                    cycleCount: resumeFrom.cycleCount,
                    decisionLog: resumeFrom.decisionLog,
                  }
                : undefined,
              onCycleStart: ({ cycle }) => {
                setActivePlanRun((prev) => {
                  if (!prev) return prev;
                  const next = {
                    ...prev,
                    cycleCount: cycle,
                    status: "running" as const,
                    nextAction: "autopilot-cycle",
                  };
                  latestPlanRunSnapshot = next;
                  session?.savePlanRun(next);
                  setPlanRuns((runs) => upsertPlanRun(runs, next));
                  return next;
                });
              },
              onDecision: ({ decision }) => {
                setActivePlanRun((prev) => {
                  if (!prev) return prev;
                  const next = {
                    ...prev,
                    cycleCount: Math.max(prev.cycleCount ?? 0, decision.cycle),
                    decisionLog: [...(prev.decisionLog ?? []), { ...decision }],
                    stopReason: decision.kind === "stop" ? decision.reason : prev.stopReason,
                  };
                  latestPlanRunSnapshot = next;
                  session?.savePlanRun(next);
                  setPlanRuns((runs) => upsertPlanRun(runs, next));
                  return next;
                });
              },
            })
          : await executePlan(plan, state, executionOptions);

        const executionResult: PlanExecutionResult = mode === "autopilot"
          ? (result as AutopilotRunResult).result
          : result as PlanExecutionResult;
        const autopilotResult = mode === "autopilot"
          ? result as AutopilotRunResult
          : null;

        const completedPlanRun = createPlanRunRecordFromResult(session?.sessionId ?? "tui-session", executionResult, {
          goal: goalPrompt,
          prompt: displayPrompt,
          providerName: currentProvider.name,
          model: currentProvider.model,
          source: "tui",
          cwd: state.cwd,
          mode,
          cycleCount: autopilotResult?.cycleCount,
          decisionLog: autopilotResult?.decisionLog,
          stopReason: autopilotResult?.stopReason,
        });

        if (resumableMode) {
          completedPlanRun.planRunId = initialPlanRun.planRunId;
          completedPlanRun.activeTaskId = mode === "autopilot"
            ? autopilotResult?.activeTaskId
            : undefined;
          completedPlanRun.nextAction = completedPlanRun.completed ? "stop" : initialPlanRun.nextAction;
          completedPlanRun.recoveryAction = initialPlanRun.recoveryAction;
          completedPlanRun.resumeEligible = !completedPlanRun.completed;
        }

        setPlanRuns((prev) => upsertPlanRun(prev, completedPlanRun));
        session?.savePlanRun(completedPlanRun);
        const autoVerifier = startAutoVerifier({
          enabled: process.env.CORELINE_AUTO_VERIFY === "1" || process.env.CORELINE_AUTO_VERIFY === "true",
          cwd: state.cwd,
          provider: currentProvider.name,
          model: currentProvider.model,
          scheduler: state.parallelAgentScheduler,
          planRun: completedPlanRun,
          trigger: mode === "goal" || mode === "autopilot" ? mode : "plan",
        });
        const completionMessage = autoVerifier.started && autoVerifier.taskId
          ? `plan run finished; verification task ${autoVerifier.taskId}`
          : autopilotResult?.stopReason ?? completedPlanRun.error ?? "plan run finished";
        updateAgentStatus(
          completedPlanRun.status === "blocked"
            ? "blocked"
            : completedPlanRun.status === "needs_user"
              ? "needs_user"
              : completedPlanRun.status === "aborted"
                ? "aborted"
                : executionResult.completed
                  ? "completed"
                  : "failed",
          { mode, message: completionMessage },
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const snapshot = latestPlanRunSnapshot ?? initialPlanRun;
        if (snapshot) {
          const status: PlanRunRecord["status"] = ac.signal.aborted
            ? "aborted"
            : snapshot.status === "blocked"
              || snapshot.status === "needs_user"
              ? snapshot.status
              : "failed";
          const failedPlanRun: PlanRunRecord = {
            ...snapshot,
            status,
            error: errorMessage,
            completed: false,
            resumeEligible: resumableMode ? true : snapshot.resumeEligible,
          };
          setPlanRuns((prev) => upsertPlanRun(prev, failedPlanRun));
          session?.savePlanRun(failedPlanRun);
          updateAgentStatus(status, { mode, message: errorMessage });
        }
        setError(errorMessage);
      } finally {
        setIsLoading(false);
        setStreamingText("");
        setReasoningText("");
        setActiveToolCalls([]);
        setActivePlanRun(null);
        abortRef.current = null;
      }
    },
    [currentProvider.model, currentProvider.name, requestPermission, runPlannedTaskInTui, session, state, updateAgentStatus],
  );

  // Ctrl+P → provider switcher UI
  // Ctrl+N / Ctrl+B → cycle next/previous provider (IDE-style)
  // Ctrl+1..9 → jump to N-th provider directly
  // Ctrl+C → abort/exit
  useInput((input, key) => {
    if (!runtimeProviderRegistry || isLoading) {
      if (key.ctrl && input === "c") {
        if (isLoading && abortRef.current) {
          abortRef.current.abort();
          setIsLoading(false);
          setStreamingText("");
          return;
        }
        exit();
      }
      return;
    }

    if (key.ctrl && input === "p") {
      setRuntimeProviderRegistry((prev) => reloadProviderRegistry(prev, settings.defaultProvider));
      setShowProviderSwitcher(true);
      return;
    }

    // Quick-switch: Ctrl+N (next) / Ctrl+B (back/previous)
    if (key.ctrl && (input === "n" || input === "b")) {
      const names = runtimeProviderRegistry.listProviders();
      const next = resolveCycleProvider(names, currentProvider.name, input === "n" ? "next" : "previous");
      if (next) handleProviderSwitch(next);
      return;
    }

    // Numeric quick-select: Ctrl+1 ~ Ctrl+9
    if (key.ctrl) {
      const names = runtimeProviderRegistry.listProviders();
      const selected = resolveNumericProvider(names, input);
      if (selected) {
        handleProviderSwitch(selected);
        return;
      }
    }

    if (key.ctrl && input === "c") {
      if (isLoading && abortRef.current) {
        abortRef.current.abort();
        setIsLoading(false);
        setStreamingText("");
        return;
      }
      exit();
    }
  });

  // Provider switch handler (H4: use React state, not mutation)
  const handleProviderSwitch = useCallback(
    (name: string) => {
      if (!runtimeProviderRegistry) return;
      try {
        const newProvider = runtimeProviderRegistry.getProvider(name);
        state.provider = newProvider; // keep AppState in sync
        state.subAgentRuntime = createRootSubAgentRuntime(
          newProvider,
          [...state.tools.values()],
          runtimeProviderRegistry,
        );
        setCurrentProvider(newProvider); // trigger React re-render
        runtimeProviderRegistry.setDefault(name);
      } catch (err) {
        setError(`Failed to switch: ${(err as Error).message}`);
      }
    },
    [runtimeProviderRegistry, state],
  );

  // Submit handler — handles slash commands or drives agent loop
  const handleSubmit = useCallback(
    async (text: string) => {
      setError(null);
      setHistory((prev) => [text, ...prev]);

      const latestPermissions = loadPermissions();
      state.permissionContext.mode = latestPermissions.mode;
      state.permissionContext.rules = latestPermissions.rules;

      // Slash command handling
      const slashResult = handleSlashCommand(text);
      if (slashResult.handled) {
        let commandOutput = slashResult.output;
        if (slashResult.action === "clear") {
          setMessages([]);
          setDisplayMessages([]);
          setPlanRuns([]);
          setActivePlanRun(null);
        } else if (slashResult.action === "exit") {
          exit();
          return;
        } else if (slashResult.action === "switch_provider" && runtimeProviderRegistry && slashResult.data) {
          handleProviderSwitch(slashResult.data as string);
        } else if (slashResult.action === "role") {
          try {
            const roles = loadRoles();
            const requested = typeof slashResult.data === "string" ? slashResult.data : "";
            if (!requested) {
              commandOutput = roles.length > 0
                ? `Available roles:\n${roles.map((role) => `- ${role.id}: ${role.name}`).join("\n")}`
                : "No roles configured.";
            } else {
              const role = findRole(roles, requested);
              if (!role) {
                commandOutput = `Role not found: ${requested}\nAvailable roles: ${roles.map((entry) => entry.id).join(", ") || "(none)"}`;
              } else {
                setActiveRole(role);
                updateAgentStatus("idle", { mode: "chat", message: `role switched: ${role.id}` });
                commandOutput = `Active role: ${role.name} (${role.id})`;
              }
            }
          } catch (err) {
            commandOutput = `Failed to load roles: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "prompt_save") {
          const name = typeof slashResult.data === "string" ? slashResult.data : "";
          const lastUser = [...messages].reverse().find((message) => message.role === "user");
          const promptText = lastUser ? contentToPromptText(lastUser.content) : "";
          if (!promptText.trim()) {
            commandOutput = "No previous user input to save.";
          } else {
            try {
              const snippet = savePrompt({ name, text: promptText });
              commandOutput = `Saved prompt: ${snippet.name} (${snippet.id})`;
            } catch (err) {
              commandOutput = `Failed to save prompt: ${(err as Error).message}`;
            }
          }
        } else if (slashResult.action === "prompt_list") {
          try {
            const prompts = listPrompts();
            commandOutput = prompts.length > 0
              ? `Saved prompts:\n${prompts.map((prompt) => `- ${prompt.name} (${prompt.id})`).join("\n")}`
              : "No saved prompts.";
          } catch (err) {
            commandOutput = `Failed to list prompts: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "prompt_use") {
          const query = typeof slashResult.data === "string" ? slashResult.data : "";
          try {
            const snippet = findPrompt(query);
            if (!snippet) {
              commandOutput = `Prompt not found: ${query}`;
            } else {
              setPromptInsert({ text: snippet.text, key: Date.now() });
              commandOutput = `Loaded prompt into input: ${snippet.name} (${snippet.id})`;
            }
          } catch (err) {
            commandOutput = `Failed to load prompt: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "prompt_delete") {
          const query = typeof slashResult.data === "string" ? slashResult.data : "";
          try {
            const snippet = findPrompt(query);
            if (!snippet) {
              commandOutput = `Prompt not found: ${query}`;
            } else {
              deletePrompt(snippet.id);
              commandOutput = `Deleted prompt: ${snippet.name} (${snippet.id})`;
            }
          } catch (err) {
            commandOutput = `Failed to delete prompt: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "search") {
          const query = typeof slashResult.data === "string" ? slashResult.data : "";
          try {
            const results = searchTranscripts(query, { limit: 10 });
            commandOutput = results.length > 0
              ? `Transcript search (${results.length}):\n${results.map((entry) => {
                  const excerpt = entry.text.replace(/\s+/g, " ").slice(0, 140);
                  const tool = entry.toolName ? `/${entry.toolName}` : "";
                  return `- ${entry.sessionId} ${entry.role}${tool} #${entry.turnIndex}: ${excerpt}`;
                }).join("\n")}`
              : `No transcript matches: ${query}`;
          } catch (err) {
            commandOutput = `Failed to search transcripts: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "replay") {
          const requestedSessionId = typeof slashResult.data === "string" && slashResult.data.trim()
            ? slashResult.data.trim()
            : session?.sessionId;
          if (!requestedSessionId) {
            commandOutput = "No active session to replay. Usage: /replay <sessionId>";
          } else {
            try {
              const replay = replaySession(requestedSessionId);
              commandOutput = replay
                ? `Replay ${requestedSessionId}:\n${replay}`
                : `No transcript entries found for session: ${requestedSessionId}`;
            } catch (err) {
              commandOutput = `Failed to replay session: ${(err as Error).message}`;
            }
          }
        } else if (slashResult.action === "export") {
          const data = slashResult.data as { format?: string; sessionId?: string } | undefined;
          const requestedSessionId = data?.sessionId?.trim() || session?.sessionId;
          if (!requestedSessionId) {
            commandOutput = "No active session to export. Usage: /export md|pr|text [sessionId]";
          } else {
            try {
              const format = data?.format ?? "md";
              const exportOptions = {
                maxContentLength: 700,
                maxListItems: 6,
                parallelTasks: state.parallelAgentRegistry?.snapshot(),
              };
              commandOutput = format === "pr"
                ? exportSessionPrDescription(requestedSessionId, exportOptions)
                : format === "text"
                  ? exportSessionToText(requestedSessionId, exportOptions)
                  : exportSessionMarkdown(requestedSessionId, exportOptions);
            } catch (err) {
              commandOutput = `Failed to export session: ${(err as Error).message}`;
            }
          }
        } else if (slashResult.action === "undo") {
          try {
            const restored = await state.backupStore?.restoreLast();
            commandOutput = restored
              ? `Restored backup: ${restored.originalPath}`
              : "No file backup available to undo.";
          } catch (err) {
            commandOutput = `Undo failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "watchdog") {
          const data = slashResult.data as { mode?: string; seconds?: number } | undefined;
          if (data?.mode === "off") {
            setWatchdogTimeoutSeconds(undefined);
            setWatchdogSnapshot(null);
            commandOutput = "Watchdog disabled.";
          } else if (data?.mode === "set") {
            const seconds = parseWatchdogTimeoutSeconds(data.seconds);
            if (!seconds) {
              commandOutput = "Usage: /watchdog status|off|<seconds>";
            } else {
              setWatchdogTimeoutSeconds(seconds);
              setWatchdogSnapshot(null);
              commandOutput = `Watchdog enabled: ${seconds}s idle timeout.`;
            }
          } else {
            commandOutput = formatWatchdogStatus(watchdogTimeoutSeconds, watchdogSnapshot);
          }
        } else if (slashResult.action === "scaffold_generate") {
          const data = slashResult.data as { kind?: string; name?: string } | undefined;
          try {
            const result = await generateScaffold({
              rootDir: state.cwd,
              kind: data?.kind as ScaffoldKind,
              name: data?.name ?? "",
            });
            commandOutput = [
              `Scaffold generated: ${result.plan.kind} ${result.plan.name.kebab}`,
              "Created files:",
              ...result.createdFiles.map((file) => `- ${file}`),
              ...result.plan.notes.map((note) => `note: ${note}`),
            ].join("\n");
          } catch (err) {
            commandOutput = `Scaffold failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "runtime_show") {
          const snapshot = runtimeTweaks.snapshot();
          commandOutput = [
            runtimeTweaks.formatStatus(),
            ...Object.entries(snapshot.values).map(([key, value]) => {
              const defaultValue = snapshot.defaults[key as keyof typeof snapshot.defaults];
              const suffix = Object.is(value, defaultValue) ? "default" : `default=${String(defaultValue)}`;
              return `- ${key}: ${String(value)} (${suffix})`;
            }),
          ].join("\n");
        } else if (slashResult.action === "runtime_set") {
          const data = slashResult.data as { key?: string; value?: string } | undefined;
          try {
            const record = runtimeTweaks.set(data?.key ?? "", data?.value ?? "");
            const snapshot = runtimeTweaks.snapshot();
            setRuntimeTweaksSnapshot(snapshot);
            if (record.key === "budget") {
              state.costTracker?.setBudget(snapshot.values.budget);
            }
            commandOutput = `Runtime tweak set: ${record.key}=${String(record.nextValue)} (${record.changed ? "changed" : "unchanged"}) — applies next turn.`;
          } catch (err) {
            commandOutput = `Runtime tweak failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "runtime_reset") {
          const data = slashResult.data as { key?: string } | undefined;
          try {
            const record = runtimeTweaks.reset(data?.key ?? "");
            const snapshot = runtimeTweaks.snapshot();
            setRuntimeTweaksSnapshot(snapshot);
            if (record.key === "budget") {
              state.costTracker?.setBudget(snapshot.values.budget);
            }
            commandOutput = `Runtime tweak reset: ${record.key}=${String(record.nextValue)} — applies next turn.`;
          } catch (err) {
            commandOutput = `Runtime reset failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "verify_run") {
          const data = slashResult.data as { target?: string } | undefined;
          const target = data?.target ?? "all";
          const scheduler = state.parallelAgentScheduler;
          if (!scheduler) {
            commandOutput = "Verification background tasks require an interactive parallel-agent scheduler.";
          } else {
            const detected = detectVerificationCommands(state.cwd);
            const commands = target === "all"
              ? detected
              : detected.filter((command) => command.name === target);

            if (commands.length === 0) {
              commandOutput = target === "all"
                ? "No verification commands detected in package.json."
                : `No verification command detected for: ${target}`;
            } else {
              const { task, completion } = scheduler.submitTask(
                {
                  prompt: `Run verification: ${target}`,
                  description: `verification: ${commands.map((command) => command.name).join("/")}`,
                  cwd: state.cwd,
                  provider: currentProvider.name,
                  model: currentProvider.model,
                  agentDepth: 0,
                  write: false,
                },
                createForkVerifierTaskWork({
                  cwd: state.cwd,
                  commands,
                  failFast: true,
                }),
              );
              completion.catch(() => undefined);
              commandOutput = `Verification task started: ${task.id}\nUse /agent status ${task.id} or /agent read ${task.id}.`;
            }
          }
        } else if (slashResult.action === "parallel_agent_list") {
          const registry = state.parallelAgentRegistry;
          commandOutput = registry
            ? formatParallelAgentTaskCollection(registry.listTasks())
            : "Parallel agent registry is not available in this session.";
        } else if (slashResult.action === "parallel_agent_status") {
          const id = parallelAgentIdFromData(slashResult.data);
          const record = state.parallelAgentRegistry?.getTask(id);
          commandOutput = record ? formatParallelAgentStatus(record) : `Parallel agent task not found: ${id}`;
        } else if (slashResult.action === "parallel_agent_read") {
          const id = parallelAgentIdFromData(slashResult.data);
          const record = state.parallelAgentRegistry?.getTask(id);
          commandOutput = record ? formatParallelAgentTaskBlock(record) : `Parallel agent task not found: ${id}`;
        } else if (slashResult.action === "parallel_agent_stop") {
          const id = parallelAgentIdFromData(slashResult.data);
          const stopped = state.parallelAgentScheduler?.stop(id, "user") ?? false;
          commandOutput = stopped
            ? `Stop requested for parallel agent task: ${id}`
            : `Parallel agent task is not running or pending: ${id}`;
        } else if (slashResult.action === "parallel_agent_resume") {
          const id = parallelAgentIdFromData(slashResult.data);
          commandOutput = `/agent resume is not supported in Parallel Agent Runtime v1: ${id}`;
        } else if ((slashResult.action === "plan" || slashResult.action === "goal" || slashResult.action === "autopilot") && typeof slashResult.data === "string") {
          const preparedPlanPrompt = prepareUserPrompt(slashResult.data, { cwd: state.cwd });
          const planIssues = formatAtFileIssues(preparedPlanPrompt.issues);
          if (!preparedPlanPrompt.messageText.trim()) {
            setError(planIssues || "Goal is empty.");
            return;
          }
          if (planIssues) {
            setError(planIssues);
          }
          const selectedMode: PlanRunMode = slashResult.action === "goal"
            ? "goal"
            : slashResult.action === "autopilot"
              ? "autopilot"
              : "plan";
          const resumeTarget = selectedMode === "goal" && latestGoalRun?.goal === preparedPlanPrompt.messageText
            ? latestGoalRun
            : null;
          await runPlanMode(
            preparedPlanPrompt.messageText,
            preparedPlanPrompt.displayText || slashResult.data,
            selectedMode,
            resumeTarget,
          );
        } else if (slashResult.action === "test_loop") {
          try {
            const command = typeof slashResult.data === "string" && slashResult.data.trim()
              ? slashResult.data.trim()
              : undefined;
            const { events, result } = await runTestFixLoopToCompletion({
              cwd: state.cwd,
              command,
              maxAttempts: 3,
              signal: state.abortController.signal,
            });
            commandOutput = [
              `Test loop ${result.passed ? "passed" : "stopped"}: ${result.stoppedReason}`,
              ...events.map((event) => `- [${event.attempt}] ${event.message}`),
            ].join("\n");
          } catch (err) {
            commandOutput = `Test loop failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "skill") {
          const data = slashResult.data as { command?: string; value?: string } | undefined;
          try {
            switch (data?.command) {
              case "list":
                commandOutput = listBuiltInSkills()
                  .map((skill) => `- ${skill.id}: ${skill.title} — ${skill.summary}`)
                  .join("\n");
                break;
              case "show":
                commandOutput = formatSkillForDisplay(data.value ?? "");
                break;
              case "use": {
                const ids = parseSkillIdList(data.value ?? "");
                setExplicitSkillIds(ids);
                commandOutput = `Explicit built-in skills: ${ids.join(", ")}`;
                break;
              }
              case "clear":
                setExplicitSkillIds([]);
                commandOutput = "Explicit built-in skills cleared.";
                break;
              case "auto":
                setAutoSkillsEnabled(data.value === "on");
                commandOutput = `Auto skills: ${data.value === "on" ? "on" : "off"}`;
                break;
              case "stats": {
                const projectId = state.projectMemory?.projectId;
                if (!projectId) {
                  commandOutput = "Skill stats unavailable: no active project memory.";
                  break;
                }
                const skillsToShow = data.value
                  ? [data.value]
                  : listBuiltInSkills().map((s) => s.id);
                const rows: string[] = [
                  "| skill | total | passed | pass_rate | avg_turns | unclear |",
                  "| --- | ---: | ---: | ---: | ---: | ---: |",
                ];
                for (const skillId of skillsToShow) {
                  const records = readEvidence(projectId, "skill", skillId, { sinceDays: 90 });
                  const summary = summariseEval(records);
                  const pr = summary.passRate === null ? "-" : `${summary.passRate}%`;
                  const turnsValues = records
                    .map((r) => r.outcome.turnsUsed)
                    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
                  const avgTurns =
                    turnsValues.length > 0
                      ? (turnsValues.reduce((a, b) => a + b, 0) / turnsValues.length).toFixed(1)
                      : "-";
                  rows.push(
                    `| ${skillId} | ${summary.total} | ${summary.passed} | ${pr} | ${avgTurns} | ${summary.unclearCount} |`,
                  );
                }
                commandOutput = rows.join("\n");
                break;
              }
              case "status":
              default:
                commandOutput = formatSkillStatus(explicitSkillIds, autoSkillsEnabled);
                break;
            }
          } catch (err) {
            commandOutput = `Skill command failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "context") {
          const prompt = typeof slashResult.data === "string" && slashResult.data !== "current"
            ? slashResult.data
            : contentToPromptText([...messages].reverse().find((message) => message.role === "user")?.content ?? "");
          const result = collectContextCandidates({ cwd: state.cwd, prompt });
          commandOutput = result.candidates.length > 0
            ? `Context candidates:\n${result.candidates.map((candidate) => `- ${candidate.path} (${candidate.reasons.join(", ")})`).join("\n")}`
            : "No context candidates found.";
        } else if (slashResult.action === "macro") {
          const data = slashResult.data as { command?: string; value?: string } | undefined;
          try {
            const macro = parsePromptMacro(data?.value ?? "");
            const validation = validatePromptMacro(macro);
            commandOutput = validation.ok
              ? `Macro valid: ${macro.name} (${macro.steps.length} step(s))`
              : `Macro invalid:\n${validation.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`;
          } catch (err) {
            commandOutput = `Macro parse failed: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "compact") {
          const activeSystemPrompt = currentSystemPrompt;
          const systemPromptTokens = estimateTokens(activeSystemPrompt);
          const result = compactMessages(messages, systemPromptTokens, {
            maxTokens: currentProvider.maxContextTokens,
            reservedForResponse: 8192,
          }, {
            snipMarkers: snipRegistry,
          });
          if (result.compacted) {
            setMessages(result.messages);
            setDisplayMessages((prev) => [
              ...prev,
              { role: "assistant", text: `Context compacted: ${result.droppedCount} old messages summarized.` },
            ]);
          } else {
            setDisplayMessages((prev) => [
              ...prev,
              { role: "assistant", text: "No compaction needed — context is within budget." },
            ]);
          }
        } else if (
          slashResult.action === "fact" ||
          slashResult.action === "memory_decay" ||
          slashResult.action === "link" ||
          slashResult.action === "search_precise" ||
          slashResult.action === "incident" ||
          slashResult.action === "decision" ||
          slashResult.action === "evidence_first" ||
          slashResult.action === "runbook" ||
          slashResult.action === "rca" ||
          slashResult.action === "memory_health" ||
          slashResult.action === "memory_evidence_rotate" ||
          slashResult.action === "brand_spec"
        ) {
          const projectMemory = state.projectMemory;
          if (!projectMemory) {
            commandOutput = "Error: project memory is not available in this session.";
          } else {
            const handlerContext: HandlerContext = {
              projectMemory,
              projectId: projectMemory.projectId,
            };
            const data = slashResult.data;
            try {
              switch (slashResult.action) {
                case "fact":
                  commandOutput = await handleFactCommand(data as FactCommandData, handlerContext);
                  break;
                case "memory_decay":
                  commandOutput = await handleDecayCommand(data as DecayCommandData, handlerContext);
                  break;
                case "link":
                  commandOutput = await handleLinkCommand(data as LinkCommandData, handlerContext);
                  break;
                case "search_precise":
                  commandOutput = await handleSearchPreciseCommand(
                    data as SearchPreciseCommandData,
                    handlerContext,
                  );
                  break;
                case "incident":
                  commandOutput = await handleIncidentCommand(
                    data as IncidentCommandData,
                    handlerContext,
                  );
                  break;
                case "decision":
                  commandOutput = await handleDecisionCommand(
                    data as DecisionCommandData,
                    handlerContext,
                  );
                  break;
                case "evidence_first":
                  commandOutput = await handleEvidenceFirstCommand(
                    data as EvidenceFirstCommandData,
                    handlerContext,
                  );
                  break;
                case "runbook":
                  commandOutput = await handleRunbookCommand(
                    data as RunbookCommandData,
                    handlerContext,
                  );
                  break;
                case "rca":
                  commandOutput = await handleRcaCommand(data as RcaCommandData, handlerContext);
                  break;
                case "memory_health":
                  commandOutput = await handleMemoryHealthCommand(data, handlerContext);
                  break;
                case "memory_evidence_rotate":
                  commandOutput = await handleEvidenceRotateCommand(
                    data as EvidenceRotateData,
                    handlerContext,
                  );
                  break;
                case "brand_spec":
                  commandOutput = await handleBrandSpecCommand(
                    data as BrandSpecCommandData,
                    handlerContext,
                  );
                  break;
              }
            } catch (err) {
              commandOutput = `Error: ${(err as Error).message}`;
            }
          }
        } else if (slashResult.action === "slop_check") {
          try {
            commandOutput = await handleSlopCheck(
              slashResult.data as SlopCheckCommandData,
              { cwd: state.cwd },
            );
          } catch (err) {
            commandOutput = `Error: ${(err as Error).message}`;
          }
        } else if (slashResult.action === "critique") {
          try {
            const projectMemory = state.projectMemory;
            const handlerContext: HandlerContext = {
              projectMemory: projectMemory ?? ({
                projectId: "default",
              } as unknown as HandlerContext["projectMemory"]),
              projectId: projectMemory?.projectId ?? "default",
              rootDir: state.cwd,
            };
            commandOutput = await handleCritiqueCommand(
              slashResult.data as CritiqueCommandData,
              handlerContext,
            );
          } catch (err) {
            commandOutput = `Error: ${(err as Error).message}`;
          }
        }
        if (commandOutput) {
          // Model/provider/session info injection
          let output = commandOutput;
          output = output.replace("[model info — populated by REPL]", `Model: ${currentProvider.model} (${currentProvider.name})`);
          output = output.replace("[provider info — populated by REPL]", `Provider: ${currentProvider.name} (${currentProvider.type}) — ${currentProvider.model}`);
          output = output.replace("[session info — populated by REPL]", `Session: ${session?.sessionId ?? "none"}, Messages: ${messages.length}`);
          setDisplayMessages((prev) => [...prev, { role: "assistant", text: output }]);
        }
        return;
      }

      const preparedPrompt = prepareUserPrompt(text, { cwd: state.cwd });
      const attachmentIssueText = formatAtFileIssues(preparedPrompt.issues);

      if (!preparedPrompt.messageText.trim()) {
        setError(attachmentIssueText || "Prompt is empty.");
        return;
      }

      if (attachmentIssueText) {
        setError(attachmentIssueText);
      }

      // Add user message + persist to session (C5)
      const userMsg: ChatMessage = { role: "user", content: preparedPrompt.messageText };
      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setDisplayMessages((prev) => [...prev, { role: "user", text: preparedPrompt.displayText || text }]);
      session?.saveMessage(userMsg);

      // Reset streaming state
      setStreamingText("");
      setReasoningText("");
      setActiveToolCalls([]);
      setIsLoading(true);
      updateAgentStatus("running", { mode: "chat", message: "waiting for response", turn: turnCount + 1 });

      // Fresh abort controller per turn
      const ac = new AbortController();
      abortRef.current = ac;
      state.abortController = ac;
      const watchdog = watchdogTimeoutSeconds
        ? new ProgressWatchdog({
            timeoutSeconds: watchdogTimeoutSeconds,
            onTimeout: (snapshot) => {
              setWatchdogSnapshot(snapshot);
              const message = `Watchdog timeout: no progress for ${snapshot.timeoutSeconds}s${snapshot.lastLabel ? ` after ${snapshot.lastLabel}` : ""}`;
              setDisplayMessages((prev) => [...prev, { role: "assistant", text: message }]);
              updateAgentStatus("aborted", { mode: "chat", message });
              ac.abort();
            },
          })
        : undefined;
      if (watchdog) {
        setWatchdogSnapshot(watchdog.start());
      }

      try {
        const persistedMessages: ChatMessage[] = [];
        const activeSkillResult = selectBuiltInSkills({
          rawText: preparedPrompt.rawText,
          displayText: preparedPrompt.displayText,
          preparedText: preparedPrompt.messageText,
          expandedFileBodies: preparedPrompt.attachments.map((attachment) => attachment.content),
          explicitSkillIds,
          autoSkillsEnabled,
          mode: "chat",
          isRootAgent: true,
        });
        const turnSystemPrompt = buildSystemPrompt(
          state.cwd,
          [...state.tools.values()],
          state.projectMemory,
          currentProvider,
          activeRole,
          { activeSkills: activeSkillResult.selections, hardeningHints: state.hardeningHints },
        );

        const loop = agentLoop({
          state,
          messages: updatedMessages,
          systemPrompt: turnSystemPrompt,
          maxTurns: runtimeValues.maxTurns,
          temperature: runtimeValues.temperature,
          maxResultChars: runtimeValues.maxResultChars,
          autoSummary: runtimeValues.autoSummary,
          snipRegistry,
          onMessage: (message) => {
            persistedMessages.push(message);
            session?.saveMessage(message);
          },
        });

        let currentText = "";
        const currentToolCalls: ToolCallDisplay[] = [];
        let localTurnCount = 0;

        let currentReasoning = "";
        for await (const event of loopIterable(loop)) {
          if (watchdog) {
            setWatchdogSnapshot(watchdog.touch(event.type));
          }
          switch (event.type) {
            case "text_delta":
              currentText += event.text;
              setStreamingText(currentText);
              break;

            case "reasoning_delta":
              currentReasoning += event.text;
              setReasoningText(currentReasoning);
              break;

            case "tool_start": {
              const tc: ToolCallDisplay = {
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
                status: "running",
              };
              currentToolCalls.push(tc);
              setActiveToolCalls([...currentToolCalls]);
              break;
            }

            case "tool_end": {
              const idx = currentToolCalls.findIndex(
                (t) => t.toolUseId === event.toolUseId,
              );
              if (idx !== -1) {
                currentToolCalls[idx] = {
                  ...currentToolCalls[idx]!,
                  result: event.result,
                  isError: event.isError,
                  status: "done",
                };
                setActiveToolCalls([...currentToolCalls]);
              }
              break;
            }

            case "turn_end":
              localTurnCount++;
              setTurnCount((prev) => prev + 1);
              break;

            case "error":
              setError(event.error.message);
              break;

            case "warning":
              setDisplayMessages((prev) => [...prev, { role: "assistant", text: `Warning: ${event.message}` }]);
              break;

            case "watchdog_timeout":
              setDisplayMessages((prev) => [...prev, { role: "assistant", text: event.message }]);
              break;

            case "permission_ask": {
              const allowed = await requestPermission(
                event.toolUseId,
                event.toolName,
                event.input,
                `Tool "${event.toolName}" requires confirmation`,
              );
              event.resolve(allowed);
              break;
            }
          }
        }

        // Finalize: save assistant message
        if (currentText || currentToolCalls.length > 0) {
          setDisplayMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: currentText,
              toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
            },
          ]);

        }

        if (persistedMessages.length > 0) {
          setMessages((prev) => [...prev, ...persistedMessages]);
        }
        updateAgentStatus("idle", { mode: "chat", message: "turn completed", turn: turnCount + localTurnCount });
      } catch (err) {
        if (!ac.signal.aborted) {
          setError((err as Error).message);
          updateAgentStatus("failed", { mode: "chat", message: (err as Error).message });
        } else {
          updateAgentStatus("aborted", { mode: "chat", message: "turn aborted" });
        }
      } finally {
        if (watchdog) {
          setWatchdogSnapshot(watchdog.stop());
        }
        setIsLoading(false);
        setStreamingText("");
        setReasoningText("");
        setActiveToolCalls([]);
        abortRef.current = null;
      }
    },
    [
      messages,
      state,
      currentSystemPrompt,
      runtimeValues,
      runtimeTweaks,
      snipRegistry,
      exit,
      runtimeProviderRegistry,
      handleProviderSwitch,
      currentProvider,
      session,
      requestPermission,
      latestGoalRun,
      runPlanMode,
      turnCount,
      updateAgentStatus,
      watchdogSnapshot,
      watchdogTimeoutSeconds,
      explicitSkillIds,
      autoSkillsEnabled,
      activeRole,
    ],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (showProviderSwitcher && runtimeProviderRegistry) {
    return (
      <ProviderSwitcher
        providers={runtimeProviderRegistry.listProviders()}
        currentProvider={state.provider.name}
        onSelect={handleProviderSwitch}
        onClose={() => setShowProviderSwitcher(false)}
      />
    );
  }

  // Structured question prompt takes over the screen while AskUserQuestion is waiting.
  if (pendingQuestion) {
    return (
      <AskUserQuestionPrompt
        questions={pendingQuestion.questions}
        onResolve={(answers) => pendingQuestion.resolve({ answers })}
        onCancel={() => pendingQuestion.resolve({ answers: [], cancelled: true })}
      />
    );
  }

  // Permission prompt takes over the screen when pending
  if (pendingPermission) {
    return (
      <PermissionPrompt
        toolName={pendingPermission.toolName}
        input={pendingPermission.input}
        reason={pendingPermission.reason}
        onResolve={pendingPermission.resolve}
      />
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box paddingX={1} marginBottom={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">coreline-agent</Text>
          <Text dimColor> — type a message to start. Ctrl+C to exit.</Text>
        </Box>
        {runtimeProviderRegistry && (
          <Box>
            <Text dimColor>Provider: </Text>
            <Text color="cyan" bold>{currentProvider.name}</Text>
            {activeRole && (
              <>
                <Text dimColor>  •  Role: </Text>
                <Text color="yellow">{activeRole.id}</Text>
              </>
            )}
            <Text dimColor>  •  </Text>
            <Text dimColor>Ctrl+P list · Ctrl+N/B cycle · Ctrl+1..9 jump</Text>
          </Box>
        )}
      </Box>

      {/* Message history */}
      {displayMessages.map((msg, i) => (
        <Box key={i} flexDirection="column" paddingX={1} marginBottom={1}>
          {msg.role === "user" ? (
            <Box>
              <Text color="green" bold>You: </Text>
              <Text>{msg.text}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color="magenta" bold>Agent: </Text>
              {msg.toolCalls?.map((tc) => (
                <ToolResult key={tc.toolUseId} toolCall={tc} />
              ))}
              {msg.text && <Text>{msg.text}</Text>}
            </Box>
          )}
        </Box>
      ))}

      {latestGoalRun && (
        <Box flexDirection="column" paddingX={1} marginBottom={1} borderStyle="single" borderColor="yellow">
          <Box marginBottom={1}>
            <Text color="yellow" bold>Resumable Goal</Text>
          </Box>
          {formatGoalResumeLines(latestGoalRun).map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      )}

      {planRuns.map((run) => (
        <PlanRunPanel key={run.planRunId} run={run} />
      ))}

      {activePlanRun && (
        <PlanRunPanel run={activePlanRun} />
      )}

      {/* Active streaming / tool calls / reasoning */}
      {isLoading && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="magenta" bold>Agent: </Text>
          <ReasoningOutput text={reasoningText} isActive={true} show={runtimeValues.showReasoning} />
          {activeToolCalls.map((tc) => (
            <ToolResult key={tc.toolUseId} toolCall={tc} />
          ))}
          <StreamingOutput text={streamingText} isStreaming={true} />
        </Box>
      )}

      {/* Error display */}
      {error && (
        <Box paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        providerName={currentProvider.name}
        model={currentProvider.model}
        inputTokens={state.totalUsage.inputTokens}
        outputTokens={state.totalUsage.outputTokens}
        permissionMode={state.permissionContext.mode}
        turnCount={turnCount}
        isLoading={isLoading}
        theme={settings.theme}
        mcpStatus={mcpStatus}
        proxyStatus={proxyStatus}
        agentStatus={agentStatus}
        cost={state.costTracker?.getCost()}
        runtimeTweaks={runtimeTweaks.formatStatus()}
      />

      {/* Prompt input */}
      <PromptInput
        onSubmit={handleSubmit}
        isDisabled={isLoading}
        history={history}
        insertText={promptInsert?.text}
        insertKey={promptInsert?.key}
        placeholder={isLoading ? "Waiting for response..." : "Message..."}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Helper: iterate an AsyncGenerator as AsyncIterable (consume values only)
// ---------------------------------------------------------------------------

async function* loopIterable<T, R>(
  gen: AsyncGenerator<T, R>,
): AsyncIterable<T> {
  let result = await gen.next();
  while (!result.done) {
    yield result.value;
    result = await gen.next();
  }
}
