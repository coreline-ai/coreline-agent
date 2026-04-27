import type { PlanRunRecord, PlanRunStatus } from "../../session/records.js";
import type { AutopilotDecisionRecord, Task, TaskStatus } from "../plan-execute/types.js";
import type { DoNotRepeatAdvice, RecoveryCheckpoint, ResumeAdvice, ResumeAdviceAction, ResumeRisk } from "./types.js";

export interface CreateRecoveryCheckpointOptions {
  checkpointId?: string;
  createdAt?: string;
}

const COMPLETED_STATUSES = new Set<TaskStatus>(["completed", "verified"]);
const FAILURE_STATUSES = new Set<TaskStatus>(["failed", "blocked", "needs_user", "aborted"]);

function nowIso(): string {
  return new Date().toISOString();
}

function stablePart(value: unknown): string {
  return String(value ?? "none")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "none";
}

function createStableCheckpointId(run: PlanRunRecord): string {
  return [
    "recovery",
    stablePart(run.sessionId),
    stablePart(run.planRunId),
    stablePart(run.status),
    stablePart(run.activeTaskId),
    stablePart(run.lastFailureClass),
  ].join(":");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function uniqueAdvice(values: DoNotRepeatAdvice[]): DoNotRepeatAdvice[] {
  const seen = new Set<string>();
  const result: DoNotRepeatAdvice[] = [];
  for (const advice of values) {
    const key = [advice.taskId ?? "", advice.toolUseId ?? "", advice.reason, advice.evidence ?? ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(advice);
  }
  return result;
}

function allRunTasks(run: PlanRunRecord): Task[] {
  const byId = new Map<string, Task>();
  for (const task of run.plan?.tasks ?? []) {
    byId.set(task.id, task);
  }
  for (const step of run.steps ?? []) {
    byId.set(step.task.id, { ...byId.get(step.task.id), ...step.task, dependsOn: step.task.dependsOn });
  }
  return [...byId.values()];
}

function completedTaskIds(run: PlanRunRecord): string[] {
  return uniqueStrings(allRunTasks(run).filter((task) => COMPLETED_STATUSES.has(task.status)).map((task) => task.id));
}

function findActiveTaskId(run: PlanRunRecord): string | undefined {
  if (run.activeTaskId) return run.activeTaskId;
  return allRunTasks(run).find((task) => !COMPLETED_STATUSES.has(task.status))?.id;
}

function findLatestTaskWithStatus(run: PlanRunRecord, statuses: Set<TaskStatus>): Task | undefined {
  const stepTask = [...(run.steps ?? [])].reverse().find((step) => statuses.has(step.task.status))?.task;
  if (stepTask) return stepTask;
  return [...allRunTasks(run)].reverse().find((task) => statuses.has(task.status));
}

function getStringField(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found;
  }
  return undefined;
}

function findLastSuccessfulToolUseId(run: PlanRunRecord): string | undefined {
  for (const step of [...(run.steps ?? [])].reverse()) {
    if (!COMPLETED_STATUSES.has(step.task.status)) continue;
    const fromResult = getStringField(step.result, ["toolUseId", "tool_use_id", "id"]);
    const fromOutput = getStringField(step.output, ["toolUseId", "tool_use_id"]);
    if (fromResult || fromOutput) return fromResult ?? fromOutput;
  }
  return undefined;
}

function findFailedToolUseId(run: PlanRunRecord): string | undefined {
  for (const step of [...(run.steps ?? [])].reverse()) {
    if (!FAILURE_STATUSES.has(step.task.status)) continue;
    const fromResult = getStringField(step.result, ["toolUseId", "tool_use_id", "id"]);
    const fromOutput = getStringField(step.output, ["toolUseId", "tool_use_id"]);
    if (fromResult || fromOutput) return fromResult ?? fromOutput;
  }
  return undefined;
}

function latestFailureReason(run: PlanRunRecord): string | undefined {
  const failedTask = findLatestTaskWithStatus(run, FAILURE_STATUSES);
  const failedStep = [...(run.steps ?? [])].reverse().find((step) => FAILURE_STATUSES.has(step.task.status));
  return run.lastFailureReason
    ?? failedTask?.failureReason
    ?? failedTask?.recovery?.lastFailureReason
    ?? failedTask?.recovery?.reason
    ?? failedStep?.evaluation?.reason
    ?? run.error
    ?? run.stopReason;
}

function isPermissionOrHookIssue(text: string | undefined): boolean {
  return /permission|denied|approval|approve|hook|blocking|blocked/i.test(text ?? "");
}

function isTransientIssue(text: string | undefined): boolean {
  return /timeout|timed? out|network|econn|rate.?limit|429|503|502|provider|temporary|transient|flaky/i.test(text ?? "");
}

function latestDecision(run: PlanRunRecord): AutopilotDecisionRecord | undefined {
  return [...(run.decisionLog ?? [])].sort((a, b) => a.cycle - b.cycle || a.createdAt.localeCompare(b.createdAt)).at(-1);
}

function suggestedNextActionForRun(run: PlanRunRecord): string {
  if (run.nextAction) return run.nextAction;
  if (run.recoveryAction === "ask-user" || run.status === "needs_user" || run.lastFailureClass === "needs_user") {
    return "ask_user: collect the missing confirmation or input before resuming";
  }
  if (run.recoveryAction === "stop" || run.status === "aborted" || run.lastFailureClass === "aborted") {
    return "stop: do not resume automatically until the abort reason is reviewed";
  }
  const reason = latestFailureReason(run);
  if (run.status === "blocked" || run.lastFailureClass === "blocked") {
    return isPermissionOrHookIssue(reason)
      ? "ask_user: resolve permission or hook blocking before continuing"
      : "replan: adjust the remaining plan around the blocking condition";
  }
  if (run.recoveryAction === "retry") return "retry: retry the failed task once before replanning";
  if (run.recoveryAction === "replan") return "replan: build a new plan for unfinished work";
  if (run.status === "failed" || run.lastFailureClass === "failed") {
    return isTransientIssue(reason)
      ? "retry: transient failure suspected, retry with the same task context"
      : "replan: failure is not clearly transient, create a safer continuation plan";
  }
  if (run.status === "completed" || run.completed) return "stop: run is already completed";
  return "continue: resume from the active or first unfinished task";
}

function buildDoNotRepeatAdvice(run: PlanRunRecord): DoNotRepeatAdvice[] {
  const advice: DoNotRepeatAdvice[] = [];
  for (const task of allRunTasks(run)) {
    if (!COMPLETED_STATUSES.has(task.status)) continue;
    advice.push({
      taskId: task.id,
      reason: "completed_or_verified_task",
      evidence: `Task ${task.id} is ${task.status}; do not re-run it unless the user explicitly asks.`,
    });
  }

  const lastSuccessfulToolUseId = findLastSuccessfulToolUseId(run);
  if (lastSuccessfulToolUseId) {
    advice.push({
      toolUseId: lastSuccessfulToolUseId,
      reason: "last_successful_tool_use",
      evidence: "Last successful tool use is already represented in the plan run record.",
    });
  }

  const decision = latestDecision(run);
  if (decision?.guardKind === "repeated_failure" || decision?.guardKind === "repeated_tail" || decision?.guardKind === "no_progress") {
    advice.push({
      taskId: decision.taskId,
      reason: `autopilot_guard_${decision.guardKind}`,
      evidence: decision.reason,
    });
  }

  return uniqueAdvice(advice);
}

export function createRecoveryCheckpoint(
  run: PlanRunRecord,
  options: CreateRecoveryCheckpointOptions = {},
): RecoveryCheckpoint {
  const failedTask = findLatestTaskWithStatus(run, FAILURE_STATUSES);
  return {
    checkpointId: options.checkpointId ?? createStableCheckpointId(run),
    sessionId: run.sessionId,
    createdAt: options.createdAt ?? nowIso(),
    planRunId: run.planRunId,
    completedTaskIds: completedTaskIds(run),
    activeTaskId: findActiveTaskId(run),
    lastSuccessfulToolUseId: findLastSuccessfulToolUseId(run),
    failedToolUseId: findFailedToolUseId(run),
    failureReason: latestFailureReason(run),
    doNotRepeat: buildDoNotRepeatAdvice(run),
    suggestedNextAction: suggestedNextActionForRun({ ...run, activeTaskId: run.activeTaskId ?? failedTask?.id }),
  };
}

function actionFromRun(run: PlanRunRecord | undefined, checkpoint: RecoveryCheckpoint): ResumeAdviceAction {
  if (!run) return checkpoint.suggestedNextAction.startsWith("stop") ? "stop" : "unknown";
  const reason = checkpoint.failureReason ?? run.lastFailureReason ?? run.stopReason;
  if (run.status === "completed" || run.completed) return "stop";
  if (run.status === "needs_user" || run.lastFailureClass === "needs_user" || run.recoveryAction === "ask-user") return "ask_user";
  if (run.status === "aborted" || run.lastFailureClass === "aborted" || run.recoveryAction === "stop") return "stop";
  if (run.status === "blocked" || run.lastFailureClass === "blocked") return isPermissionOrHookIssue(reason) ? "ask_user" : "replan";
  if (run.recoveryAction === "retry") return "retry";
  if (run.recoveryAction === "replan") return "replan";
  if (run.status === "failed" || run.lastFailureClass === "failed") return isTransientIssue(reason) ? "retry" : "replan";
  if (run.resumeEligible === false) return "stop";
  return "continue";
}

export function classifyResumeRisk(checkpoint: RecoveryCheckpoint, latestRun?: PlanRunRecord | null): ResumeRisk {
  const run = latestRun ?? undefined;
  const reason = checkpoint.failureReason ?? run?.lastFailureReason ?? run?.stopReason;
  if (!run) return "medium";
  if (run.status === "completed" || run.completed) return "low";
  if (run.status === "aborted" || run.lastFailureClass === "aborted" || run.recoveryAction === "stop") return "high";
  if (run.status === "needs_user" || run.lastFailureClass === "needs_user") return "high";
  if (isPermissionOrHookIssue(reason)) return "high";
  if (run.status === "blocked" || run.lastFailureClass === "blocked") return "high";
  if (run.status === "failed" || run.lastFailureClass === "failed") return isTransientIssue(reason) ? "medium" : "high";
  if (checkpoint.doNotRepeat.length > 5) return "medium";
  return "low";
}

function reasonForAdvice(action: ResumeAdviceAction, risk: ResumeRisk, run: PlanRunRecord | undefined, checkpoint: RecoveryCheckpoint): string {
  const status = run?.status ?? "unknown";
  const failure = checkpoint.failureReason ?? run?.lastFailureReason ?? run?.stopReason;
  const suffix = failure ? ` Latest failure: ${failure}` : "";
  switch (action) {
    case "continue":
      return `Resume from unfinished work with ${risk} risk.${suffix}`;
    case "retry":
      return `Retry is recommended because the failure appears transient or retry was explicitly requested.${suffix}`;
    case "replan":
      return `Replan the remaining work because status is ${status} and direct retry is not clearly safe.${suffix}`;
    case "ask_user":
      return `Ask the user before resuming because status is ${status} or permission/hook input is required.${suffix}`;
    case "stop":
      return `Do not resume automatically because status is ${status}.${suffix}`;
    case "unknown":
      return `No latest plan run was provided; checkpoint can only provide advisory context.${suffix}`;
  }
}

export function buildResumeAdvice(checkpoint: RecoveryCheckpoint, latestRun?: PlanRunRecord | null): ResumeAdvice {
  const run = latestRun ?? undefined;
  const action = actionFromRun(run, checkpoint);
  const risk = classifyResumeRisk(checkpoint, run);
  return {
    checkpointId: checkpoint.checkpointId,
    action,
    risk,
    reason: reasonForAdvice(action, risk, run, checkpoint),
    fromTaskId: run?.activeTaskId ?? checkpoint.activeTaskId,
    doNotRepeat: [...checkpoint.doNotRepeat],
    suggestedNextAction: checkpoint.suggestedNextAction,
  };
}

export function createResumeAdviceFromPlanRun(run: PlanRunRecord, options: CreateRecoveryCheckpointOptions = {}): ResumeAdvice {
  const checkpoint = createRecoveryCheckpoint(run, options);
  return buildResumeAdvice(checkpoint, run);
}
