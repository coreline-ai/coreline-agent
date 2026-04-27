import type { AutopilotRunResult } from "../plan-execute/autopilot.js";
import type { PlanExecutionResult } from "../plan-execute/runner.js";
import type { EvaluationResult, PlanExecutionStep, Task } from "../plan-execute/types.js";
import type { CompletionConfidence, CompletionDecision, ReliabilityEvidence } from "./types.js";

export type CompletionSignalKind = "abort" | "needs_user" | "permission_denied" | "hook_blocked" | "tool_error";

export interface CompletionSignal {
  kind: CompletionSignalKind;
  summary: string;
  taskId?: string;
  toolUseId?: string;
  detail?: string;
}

export interface CompletionJudgeInput {
  tasks?: Task[];
  steps?: PlanExecutionStep[];
  completed?: boolean;
  stopStatus?: "running" | "completed" | "failed" | "aborted" | "blocked" | "needs_user" | "partial" | "unknown";
  stopReason?: string;
  signals?: CompletionSignal[];
  evidence?: ReliabilityEvidence[];
  missingEvidence?: string[];
}

const TERMINAL_SUCCESS_STATUSES = new Set(["completed", "verified"]);

function pushEvidence(target: ReliabilityEvidence[], evidence: ReliabilityEvidence): void {
  target.push(evidence);
}

function taskEvidence(task: Task, summary?: string): ReliabilityEvidence {
  return {
    kind: "task",
    taskId: task.id,
    status: task.status,
    summary: summary ?? `${task.id} is ${task.status}`,
  };
}

function signalEvidence(signal: CompletionSignal): ReliabilityEvidence {
  const kind = signal.kind === "permission_denied"
    ? "permission"
    : signal.kind === "hook_blocked"
      ? "hook"
      : signal.kind === "tool_error"
        ? "tool_result"
        : "external";

  return {
    kind,
    taskId: signal.taskId,
    toolUseId: signal.toolUseId,
    status: signal.kind,
    summary: signal.summary,
    detail: signal.detail,
  };
}

function evaluationEvidence(step: PlanExecutionStep): ReliabilityEvidence | null {
  const evaluation: EvaluationResult | undefined = step.evaluation;
  if (!evaluation) return null;

  return {
    kind: "evaluation",
    taskId: step.task.id,
    status: evaluation.outcome,
    summary: evaluation.reason ?? `evaluation outcome: ${evaluation.outcome}`,
  };
}

function verificationEvidence(task: Task): ReliabilityEvidence | null {
  if (!task.verification) return null;

  return {
    kind: "verification",
    taskId: task.id,
    status: task.verification.status,
    summary: task.verification.summary ?? `verification ${task.verification.status}`,
  };
}

function hasPassedVerification(tasks: Task[], evidence: ReliabilityEvidence[]): boolean {
  return tasks.some((task) => task.verification?.status === "passed")
    || evidence.some((item) => item.kind === "verification" && item.status === "passed");
}

function hasSuccessfulEvaluation(steps: PlanExecutionStep[]): boolean {
  return steps.some((step) => step.evaluation?.success === true || step.evaluation?.outcome === "success");
}

function buildDecision(params: {
  outcome: CompletionDecision["outcome"];
  confidence: CompletionConfidence;
  reason: string;
  evidence: ReliabilityEvidence[];
  missingEvidence?: string[];
  recommendedNextAction?: string;
}): CompletionDecision {
  return {
    outcome: params.outcome,
    confidence: params.confidence,
    reason: params.reason,
    evidence: params.evidence,
    missingEvidence: params.missingEvidence ?? [],
    recommendedNextAction: params.recommendedNextAction,
  };
}

export function judgeCompletion(input: CompletionJudgeInput): CompletionDecision {
  const tasks = input.tasks ?? [];
  const steps = input.steps ?? [];
  const signals = input.signals ?? [];
  const evidence: ReliabilityEvidence[] = [...(input.evidence ?? [])];
  const missingEvidence = [...(input.missingEvidence ?? [])];

  for (const task of tasks) {
    pushEvidence(evidence, taskEvidence(task));
    const verification = verificationEvidence(task);
    if (verification) pushEvidence(evidence, verification);
  }

  for (const step of steps) {
    const evaluation = evaluationEvidence(step);
    if (evaluation) pushEvidence(evidence, evaluation);
  }

  for (const signal of signals) {
    pushEvidence(evidence, signalEvidence(signal));
  }

  const reasonSuffix = input.stopReason ? `: ${input.stopReason}` : "";

  // Priority: aborted > needs_user > blocked > failed > partial > completed > unknown.
  const abortedTask = tasks.find((task) => task.status === "aborted");
  const abortSignal = signals.find((signal) => signal.kind === "abort");
  if (input.stopStatus === "aborted" || abortedTask || abortSignal) {
    return buildDecision({
      outcome: "aborted",
      confidence: "high",
      reason: abortSignal?.summary ?? abortedTask?.failureReason ?? `run was aborted${reasonSuffix}`,
      evidence,
      missingEvidence,
      recommendedNextAction: "Resume only after confirming the previous run was safely interrupted.",
    });
  }

  const needsUserTask = tasks.find((task) => task.status === "needs_user");
  const needsUserSignal = signals.find((signal) => signal.kind === "needs_user");
  if (input.stopStatus === "needs_user" || needsUserTask || needsUserSignal) {
    return buildDecision({
      outcome: "needs_user",
      confidence: "high",
      reason: needsUserSignal?.summary ?? needsUserTask?.failureReason ?? needsUserTask?.nextAction ?? `run needs user input${reasonSuffix}`,
      evidence,
      missingEvidence,
      recommendedNextAction: needsUserTask?.nextAction ?? "Ask the user for the missing approval or input before continuing.",
    });
  }

  const blockedTask = tasks.find((task) => task.status === "blocked");
  const blockingSignal = signals.find((signal) => signal.kind === "permission_denied" || signal.kind === "hook_blocked");
  if (input.stopStatus === "blocked" || blockedTask || blockingSignal) {
    return buildDecision({
      outcome: "blocked",
      confidence: "high",
      reason: blockingSignal?.summary ?? blockedTask?.failureReason ?? `run is blocked${reasonSuffix}`,
      evidence,
      missingEvidence,
      recommendedNextAction: blockedTask?.nextAction ?? "Resolve the blocking condition, permission denial, or hook decision before retrying.",
    });
  }

  const failedTask = tasks.find((task) => task.status === "failed");
  const toolErrorSignal = signals.find((signal) => signal.kind === "tool_error");
  const failedStep = steps.find((step) => step.evaluation?.outcome === "failure" || step.evaluation?.success === false);
  if (input.stopStatus === "failed" || failedTask || toolErrorSignal || failedStep) {
    return buildDecision({
      outcome: "failed",
      confidence: "high",
      reason: toolErrorSignal?.summary ?? failedTask?.failureReason ?? failedStep?.evaluation.reason ?? `run failed${reasonSuffix}`,
      evidence,
      missingEvidence,
      recommendedNextAction: failedTask?.nextAction ?? "Inspect the failure evidence and retry or replan with a narrower next step.",
    });
  }

  const hasTasks = tasks.length > 0;
  const allTasksSuccessful = hasTasks && tasks.every((task) => TERMINAL_SUCCESS_STATUSES.has(task.status));
  const pendingTask = tasks.find((task) => task.status === "pending" || task.status === "running");
  const hasEvidence = evidence.length > 0;
  const hasCoreVerification = hasPassedVerification(tasks, evidence) || hasSuccessfulEvaluation(steps);

  if (hasTasks && (!allTasksSuccessful || pendingTask)) {
    return buildDecision({
      outcome: "partial",
      confidence: "medium",
      reason: pendingTask ? `task ${pendingTask.id} is still ${pendingTask.status}` : "not all tasks reached a successful terminal state",
      evidence,
      missingEvidence,
      recommendedNextAction: "Continue the remaining task work before reporting completion.",
    });
  }

  if (allTasksSuccessful && !hasCoreVerification) {
    const missing = missingEvidence.length > 0 ? missingEvidence : ["verification evidence"];
    return buildDecision({
      outcome: "partial",
      confidence: "medium",
      reason: "tasks reached a successful terminal state, but core verification evidence is missing",
      evidence,
      missingEvidence: missing,
      recommendedNextAction: "Collect deterministic verification evidence before claiming full completion.",
    });
  }

  if ((input.completed === true || input.stopStatus === "completed" || allTasksSuccessful) && hasCoreVerification) {
    return buildDecision({
      outcome: "completed",
      confidence: "high",
      reason: input.stopReason ?? "all tasks completed with verification evidence",
      evidence,
      missingEvidence,
      recommendedNextAction: "Report completion with the collected verification evidence.",
    });
  }

  if (input.completed === true && hasEvidence) {
    return buildDecision({
      outcome: "partial",
      confidence: "medium",
      reason: "run reported completion, but task-level verification evidence is insufficient",
      evidence,
      missingEvidence: missingEvidence.length > 0 ? missingEvidence : ["task-level verification evidence"],
      recommendedNextAction: "Confirm task-level verification before reporting full completion.",
    });
  }

  return buildDecision({
    outcome: "unknown",
    confidence: "low",
    reason: input.stopReason ?? "insufficient evidence to judge completion",
    evidence,
    missingEvidence: missingEvidence.length > 0 ? missingEvidence : ["task status", "verification evidence"],
    recommendedNextAction: "Collect task status and verification evidence, then judge again.",
  });
}

export function completionInputFromPlanExecutionResult(result: PlanExecutionResult): CompletionJudgeInput {
  return {
    tasks: result.plan.tasks,
    steps: result.steps,
    completed: result.completed,
  };
}

export function judgePlanExecutionCompletion(result: PlanExecutionResult): CompletionDecision {
  return judgeCompletion(completionInputFromPlanExecutionResult(result));
}

export function completionInputFromAutopilotRunResult(result: AutopilotRunResult): CompletionJudgeInput {
  return {
    tasks: result.latestPlan.tasks,
    steps: result.result.steps,
    completed: result.result.completed,
    stopStatus: result.stopStatus,
    stopReason: result.stopReason,
    evidence: result.decisionLog.map((entry) => ({
      kind: "plan_run",
      status: entry.kind,
      summary: entry.reason,
      taskId: entry.taskId,
    })),
  };
}

export function judgeAutopilotCompletion(result: AutopilotRunResult): CompletionDecision {
  return judgeCompletion(completionInputFromAutopilotRunResult(result));
}
