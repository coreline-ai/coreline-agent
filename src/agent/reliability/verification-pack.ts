/**
 * VerificationPack builder.
 *
 * This module is intentionally a collector/aggregator only. It does not run
 * commands, tools, providers, hooks, or tests. Existing plan/session/tool
 * records remain the source of truth; this file derives a reportable evidence
 * bundle from those records.
 */

import type { PlanExecutionResult } from "../plan-execute/runner.js";
import type { EvaluationResult, Task, TaskOutput, TaskVerification } from "../plan-execute/types.js";
import type { AgentTraceRecord, CompletionDecision, ReliabilityEvidence, ReliabilityEvidenceKind, VerificationEvidence, VerificationEvidenceStatus, VerificationPack } from "./types.js";
import type { PlanRunRecord, PlanRunStatus, PlanStepRecord } from "../../session/records.js";
import type { ToolCallResult } from "../../tools/orchestration.js";

const DETAIL_LIMIT = 600;
const SUMMARY_LIMIT = 180;

export interface BuildVerificationPackInput {
  packId?: string;
  now?: Date | string;
  planExecutionResult?: PlanExecutionResult;
  planRunRecord?: PlanRunRecord;
  toolResults?: ToolCallResult[];
  traces?: AgentTraceRecord[];
  externalEvidence?: VerificationEvidence[];
  completionDecision?: CompletionDecision;
  /** Optional evidence kinds the caller expected to see. Missing kinds are reported, not synthesized. */
  requiredEvidenceKinds?: ReliabilityEvidenceKind[];
}

function truncate(value: string, max = DETAIL_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function stringifyShort(value: unknown, max = DETAIL_LIMIT): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return truncate(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return truncate(String(value), max);
  }
}

function createdAt(input?: Date | string): string {
  if (input instanceof Date) return input.toISOString();
  if (typeof input === "string" && input.trim().length > 0) return input;
  return new Date().toISOString();
}

function defaultPackId(timestamp: string): string {
  const compact = timestamp.replace(/[^0-9A-Za-z]/g, "").slice(0, 20) || "now";
  return `verification-pack-${compact}`;
}

function fromVerificationStatus(status: TaskVerification["status"]): VerificationEvidenceStatus {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "ambiguous":
      return "ambiguous";
    case "pending":
      return "not_run";
  }
}

function fromEvaluation(evaluation: EvaluationResult): VerificationEvidenceStatus {
  if (evaluation.outcome === "success" || evaluation.success) return "passed";
  if (evaluation.outcome === "failure") return "failed";
  return "ambiguous";
}

function fromPlanRunStatus(status?: PlanRunStatus, completed?: boolean): VerificationEvidenceStatus {
  if (status === "completed" || completed === true) return "passed";
  if (status === "failed" || status === "aborted") return "failed";
  if (status === "blocked" || status === "needs_user" || status === "running") return "ambiguous";
  return "not_run";
}

function fromTrace(trace: AgentTraceRecord): VerificationEvidenceStatus {
  switch (trace.eventKind) {
    case "tool_executed":
    case "permission_allow":
    case "evaluator_decision":
    case "completion_decision":
    case "verification_evidence":
      return trace.outcome === "failed" || trace.outcome === "failure" ? "failed" : "passed";
    case "tool_failed":
    case "permission_deny":
    case "hook_blocking":
      return "failed";
    case "permission_ask":
    case "hook_error":
    case "tool_planned":
    case "recovery_checkpoint_created":
    case "recovery_resumed":
      return "ambiguous";
  }
}

function pushEvidence(evidence: VerificationEvidence[], next: VerificationEvidence): void {
  if (!next.summary.trim()) return;
  evidence.push({
    ...next,
    summary: truncate(next.summary, SUMMARY_LIMIT),
    detail: next.detail ? truncate(next.detail) : undefined,
  });
}

function collectTaskVerification(evidence: VerificationEvidence[], task: Task): void {
  if (!task.verification) return;
  pushEvidence(evidence, {
    kind: "verification",
    status: fromVerificationStatus(task.verification.status),
    summary: task.verification.summary ?? `Task ${task.id} verification is ${task.verification.status}`,
    sourceId: task.verification.contract,
    taskId: task.id,
    detail: task.verification.strategy,
  });
}

function collectTaskOutput(
  evidence: VerificationEvidence[],
  taskId: string | undefined,
  output?: TaskOutput,
  statusHint: VerificationEvidenceStatus = "ambiguous",
): void {
  if (!output) return;
  if (output.verificationSummary) {
    pushEvidence(evidence, {
      kind: "verification",
      status: statusHint,
      summary: output.verificationSummary,
      taskId,
    });
  }
  for (const artifact of output.artifacts ?? []) {
    pushEvidence(evidence, {
      kind: artifact.kind === "verification" ? "verification" : "task",
      status: artifact.kind === "verification" ? statusHint : "not_applicable",
      summary: `${artifact.label}: ${artifact.value}`,
      sourceId: artifact.kind,
      taskId,
    });
  }
}

function collectPlanExecution(evidence: VerificationEvidence[], result: PlanExecutionResult): void {
  for (const task of result.plan.tasks) {
    collectTaskVerification(evidence, task);
    collectTaskOutput(evidence, task.id, task.output, task.verification ? fromVerificationStatus(task.verification.status) : "ambiguous");
  }

  for (const step of result.steps) {
    pushEvidence(evidence, {
      kind: "evaluation",
      status: fromEvaluation(step.evaluation),
      summary: step.evaluation.reason ?? `Task ${step.task.id} evaluated as ${step.evaluation.outcome}`,
      sourceId: step.evaluation.contract ?? step.evaluation.strategy,
      taskId: step.task.id,
      detail: stringifyShort(step.result),
    });
    collectTaskVerification(evidence, step.task);
    collectTaskOutput(evidence, step.task.id, step.output ?? step.task.output, fromEvaluation(step.evaluation));
  }
}

function collectPlanRun(evidence: VerificationEvidence[], record: PlanRunRecord): void {
  pushEvidence(evidence, {
    kind: "plan_run",
    status: fromPlanRunStatus(record.status, record.completed),
    summary: record.resultText ?? record.error ?? record.stopReason ?? `Plan run ${record.planRunId} status ${record.status ?? "unknown"}`,
    sourceId: record.planRunId,
    detail: record.summary ? stringifyShort(record.summary) : undefined,
  });

  if (record.lastVerificationSummary) {
    pushEvidence(evidence, {
      kind: "verification",
      status: record.status === "completed" ? "passed" : "ambiguous",
      summary: record.lastVerificationSummary,
      sourceId: record.planRunId,
      taskId: record.activeTaskId,
    });
  }

  for (const step of record.steps ?? []) {
    collectPlanStep(evidence, step);
  }
}

function collectPlanStep(evidence: VerificationEvidence[], step: PlanStepRecord): void {
  collectTaskVerification(evidence, step.task);
  collectTaskOutput(
    evidence,
    step.task.id,
    step.output ?? step.task.output,
    step.evaluation ? fromEvaluation(step.evaluation) : step.task.verification ? fromVerificationStatus(step.task.verification.status) : "ambiguous",
  );
  if (step.evaluation) {
    pushEvidence(evidence, {
      kind: "evaluation",
      status: fromEvaluation(step.evaluation),
      summary: step.evaluation.reason ?? `Task ${step.task.id} evaluated as ${step.evaluation.outcome}`,
      sourceId: step.evaluation.contract ?? step.evaluation.strategy,
      taskId: step.task.id,
      detail: stringifyShort(step.result),
    });
  }
}

function collectToolResults(evidence: VerificationEvidence[], toolResults: ToolCallResult[]): void {
  for (const tool of toolResults) {
    pushEvidence(evidence, {
      kind: "tool_result",
      status: tool.result.isError ? "failed" : "passed",
      summary: `${tool.toolName} ${tool.result.isError ? "failed" : "completed"}`,
      sourceId: tool.toolName,
      toolUseId: tool.toolUseId,
      detail: tool.formattedResult || stringifyShort(tool.result.data),
    });
  }
}

function collectTraces(evidence: VerificationEvidence[], traces: AgentTraceRecord[]): void {
  for (const trace of traces) {
    pushEvidence(evidence, {
      kind: trace.eventKind.startsWith("hook") ? "hook" : trace.eventKind.startsWith("permission") ? "permission" : "trace",
      status: fromTrace(trace),
      summary: trace.reason ?? `${trace.eventKind}${trace.toolName ? `: ${trace.toolName}` : ""}`,
      sourceId: trace.traceId,
      toolUseId: trace.toolUseId,
      detail: stringifyShort({ outcome: trace.outcome, metadata: trace.metadata }),
    });
  }
}

function collectCompletionDecision(evidence: VerificationEvidence[], decision: CompletionDecision): void {
  pushEvidence(evidence, {
    kind: "external",
    status: decision.outcome === "completed"
      ? "passed"
      : decision.outcome === "failed" || decision.outcome === "aborted"
        ? "failed"
        : decision.outcome === "unknown"
          ? "ambiguous"
          : "not_applicable",
    summary: decision.reason,
    sourceId: `completion:${decision.outcome}`,
    detail: stringifyShort({ confidence: decision.confidence, missingEvidence: decision.missingEvidence }),
  });

  for (const item of decision.evidence) {
    pushEvidence(evidence, reliabilityToVerificationEvidence(item));
  }
}

function reliabilityToVerificationEvidence(item: ReliabilityEvidence): VerificationEvidence {
  return {
    kind: item.kind,
    status: item.status === "failed" || item.status === "error"
      ? "failed"
      : item.status === "passed" || item.status === "success" || item.status === "completed"
        ? "passed"
        : "ambiguous",
    summary: item.summary,
    sourceId: item.status,
    taskId: item.taskId,
    toolUseId: item.toolUseId,
    detail: item.detail,
  };
}

function aggregateStatus(evidence: VerificationEvidence[], missingEvidence: string[]): VerificationEvidenceStatus {
  if (evidence.length === 0) return "not_run";
  if (evidence.some((item) => item.status === "failed")) return "failed";
  if (evidence.some((item) => item.status === "ambiguous")) return "ambiguous";
  if (missingEvidence.length > 0) return "ambiguous";
  if (evidence.some((item) => item.status === "passed")) return "passed";
  if (evidence.every((item) => item.status === "not_applicable")) return "not_applicable";
  return "not_run";
}

function summarize(status: VerificationEvidenceStatus, evidence: VerificationEvidence[], missingEvidence: string[]): string {
  const counts = evidence.reduce<Record<VerificationEvidenceStatus, number>>((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, { passed: 0, failed: 0, not_run: 0, not_applicable: 0, ambiguous: 0 });

  if (evidence.length === 0) return "No verification evidence was collected.";
  const base = `Verification ${status}: ${counts.passed} passed, ${counts.failed} failed, ${counts.ambiguous} ambiguous, ${counts.not_run} not run, ${counts.not_applicable} not applicable.`;
  if (missingEvidence.length === 0) return base;
  return `${base} Missing evidence: ${missingEvidence.join(", ")}.`;
}

function missingKinds(input: BuildVerificationPackInput, evidence: VerificationEvidence[]): string[] {
  const missing: string[] = [];
  for (const kind of input.requiredEvidenceKinds ?? []) {
    if (!evidence.some((item) => item.kind === kind)) {
      missing.push(`missing ${kind} evidence`);
    }
  }
  if (input.completionDecision) {
    missing.push(...input.completionDecision.missingEvidence);
  }
  return [...new Set(missing)];
}

export function buildVerificationPack(input: BuildVerificationPackInput = {}): VerificationPack {
  const timestamp = createdAt(input.now);
  const evidence: VerificationEvidence[] = [];

  if (input.planExecutionResult) collectPlanExecution(evidence, input.planExecutionResult);
  if (input.planRunRecord) collectPlanRun(evidence, input.planRunRecord);
  if (input.toolResults) collectToolResults(evidence, input.toolResults);
  if (input.traces) collectTraces(evidence, input.traces);
  if (input.completionDecision) collectCompletionDecision(evidence, input.completionDecision);
  for (const external of input.externalEvidence ?? []) pushEvidence(evidence, external);

  const missingEvidence = missingKinds(input, evidence);
  const status = aggregateStatus(evidence, missingEvidence);

  return {
    packId: input.packId ?? defaultPackId(timestamp),
    createdAt: timestamp,
    status,
    summary: summarize(status, evidence, missingEvidence),
    evidence,
    missingEvidence,
  };
}

export function verificationPackToReliabilityEvidence(pack: VerificationPack): ReliabilityEvidence {
  return {
    kind: "verification",
    status: pack.status,
    summary: pack.summary,
    detail: pack.evidence.slice(0, 5).map((item) => `${item.status}: ${item.summary}`).join("\n"),
  };
}
