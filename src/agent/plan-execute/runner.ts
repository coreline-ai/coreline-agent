/**
 * Minimal plan execution helper.
 */

import type { AppState } from "../context.js";
import type {
  Plan,
  Planner,
  Evaluator,
  Task,
  PlanExecuteConfig,
  PlanExecutionStep,
  EvaluationResult,
  TaskStatus,
  PlanExecutionContext,
  TaskOutput,
} from "./types.js";
import type { Replanner, ReplanRequest, ReplanResult } from "./replanner.js";
import { BasicPlanner } from "./planner.js";
import { BasicEvaluator } from "./evaluator.js";
import { normalizeTaskOutput } from "./output.js";

type TaskVerificationRecord = NonNullable<Task["verification"]>;
type TaskRecoveryRecord = NonNullable<Task["recovery"]>;
type FailureDisposition = {
  status: TaskStatus;
  recoveryAction: TaskRecoveryRecord["action"];
  nextAction?: string;
  stopExecution?: boolean;
};

const NEEDS_USER_PATTERNS = [
  /\bhuman[_\s-]?input[_\s-]?required\b/i,
  /\brequires?\s+(?:user|human)\s+(?:input|approval|confirmation)\b/i,
  /\bapproval required\b/i,
  /\bconfirm with the user\b/i,
  /\bpermission denied in non-interactive mode\b/i,
];

const BLOCKED_PATTERNS = [
  /\brate limit(?:ed)?\b/i,
  /\bservice unavailable\b/i,
  /\btemporar(?:y|ily) unavailable\b/i,
  /\bprovider unavailable\b/i,
  /\bconnection (?:refused|reset)\b/i,
  /\bnetwork (?:error|unavailable|offline)\b/i,
  /\bECONN(?:RESET|REFUSED|ABORTED)\b/i,
  /\bdependency unavailable\b/i,
  /\bupstream\b.*\b(?:failed|unavailable)\b/i,
];

export interface PlanTaskRunner {
  (task: Task, context: AppState, execution: PlanExecutionContext): Promise<unknown>;
}

export interface PlanExecutionSummary {
  completed: number;
  failed: number;
  ambiguous: number;
}

export interface PlanExecutionResult {
  plan: Plan;
  steps: PlanExecutionStep[];
  summary: PlanExecutionSummary;
  completed: boolean;
}

export interface PlanExecutionOptions extends PlanExecuteConfig {
  runTask: PlanTaskRunner;
  replanner?: Replanner;
  maxReplansPerTask?: number;
  onTaskStart?: (task: Task) => void;
  onTaskEnd?: (step: PlanExecutionStep) => void;
}

function cloneTask(task: Task): Task {
  return {
    id: task.id,
    description: task.description,
    dependsOn: [...task.dependsOn],
    status: task.status,
    result: task.result,
    output: task.output
      ? {
          ...task.output,
          artifacts: task.output.artifacts ? task.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
        }
      : undefined,
    artifacts: task.artifacts ? task.artifacts.map((artifact) => ({ ...artifact })) : undefined,
    verificationHint: task.verificationHint ? { ...task.verificationHint } : undefined,
    failureReason: task.failureReason,
    nextAction: task.nextAction,
    verification: task.verification ? { ...task.verification } : undefined,
    recovery: task.recovery ? { ...task.recovery } : undefined,
  };
}

function clonePlan(plan: Plan): Plan {
  return {
    goal: plan.goal,
    tasks: plan.tasks.map(cloneTask),
  };
}

function rebuildTaskMap(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function extractRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collectFailureTexts(result: unknown, evaluation: EvaluationResult): string[] {
  const texts = new Set<string>();
  const stack: unknown[] = [result];

  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed) texts.add(trimmed);
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const entry of current) stack.push(entry);
      continue;
    }

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (typeof value === "string" && ["reason", "message", "summary", "output", "status", "nextAction"].includes(key)) {
        const trimmed = value.trim();
        if (trimmed) texts.add(trimmed);
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  if (evaluation.reason?.trim()) {
    texts.add(evaluation.reason.trim());
  }

  return [...texts];
}

function normalizeVerificationStatus(value: unknown, fallback: TaskVerificationRecord["status"]): TaskVerificationRecord["status"] {
  const status = asString(value)?.toLowerCase();
  if (status === "passed" || status === "failed" || status === "ambiguous" || status === "pending") {
    return status;
  }

  return fallback;
}

function normalizeVerificationStrategy(
  value: unknown,
  fallback: TaskVerificationRecord["strategy"],
): TaskVerificationRecord["strategy"] {
  const strategy = asString(value)?.toLowerCase();
  if (strategy === "deterministic" || strategy === "structural" || strategy === "llm") {
    return strategy;
  }

  return fallback;
}

function normalizeRecoveryAction(value: unknown, fallback: TaskRecoveryRecord["action"]): TaskRecoveryRecord["action"] {
  const action = asString(value)?.toLowerCase();
  if (action === "retry" || action === "replan" || action === "ask-user" || action === "stop") {
    return action;
  }

  return fallback;
}

function buildExecutionContext(steps: PlanExecutionStep[]): PlanExecutionContext {
  const completedOutputs = new Map<string, TaskOutput>();
  for (const step of steps) {
    if (step.output) {
      completedOutputs.set(step.task.id, {
        ...step.output,
        artifacts: step.output.artifacts ? step.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
      });
    }
  }

  return {
    completedSteps: steps.map((step) => ({
      task: cloneTask(step.task),
      result: step.result,
      output: step.output
        ? {
            ...step.output,
            artifacts: step.output.artifacts ? step.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
          }
        : undefined,
      evaluation: { ...step.evaluation },
    })),
    completedOutputs,
  };
}

function hasPattern(texts: string[], patterns: RegExp[]): boolean {
  return texts.some((text) => patterns.some((pattern) => pattern.test(text)));
}

function inferFailureDisposition(
  result: unknown,
  evaluation: EvaluationResult,
  hasReplanner: boolean,
): FailureDisposition {
  const resultRecord = extractRecord(result);
  const explicitStatus = asString(resultRecord?.status ?? resultRecord?.taskStatus)?.toLowerCase();
  const explicitRecovery = extractRecord(resultRecord?.recovery);
  const explicitRecoveryAction = normalizeRecoveryAction(explicitRecovery?.action, undefined);
  const texts = collectFailureTexts(result, evaluation);

  if (
    explicitStatus === "needs_user"
    || explicitRecoveryAction === "ask-user"
    || hasPattern(texts, NEEDS_USER_PATTERNS)
  ) {
    return {
      status: "needs_user",
      recoveryAction: "ask-user",
      nextAction: "ask-user",
      stopExecution: true,
    };
  }

  if (explicitStatus === "blocked" || hasPattern(texts, BLOCKED_PATTERNS)) {
    return {
      status: "blocked",
      recoveryAction: hasReplanner ? "replan" : "stop",
      nextAction: hasReplanner ? "replan" : "stop",
    };
  }

  return {
    status: "failed",
    recoveryAction: hasReplanner ? "replan" : "stop",
    nextAction: hasReplanner ? "replan" : "stop",
  };
}

function getRetryBudget(task: Task): number {
  const budget = asNumber(task.recovery?.retryBudget);
  if (budget === null || budget < 0) {
    return 0;
  }

  return Math.floor(budget);
}

function getRetryCount(task: Task): number {
  const retryCount = asNumber(task.recovery?.retryCount);
  if (retryCount === null || retryCount < 0) {
    return 0;
  }

  return Math.floor(retryCount);
}

function applyVerification(
  task: Task,
  evaluation: EvaluationResult,
  result: unknown,
): TaskVerificationRecord {
  const resultRecord = extractRecord(result);
  const explicitVerification = extractRecord(resultRecord?.verification);

  const summary =
    asString(explicitVerification?.summary) ??
    asString(explicitVerification?.message) ??
    asString(evaluation.reason) ??
    asString(resultRecord?.reason) ??
    asString(resultRecord?.message) ??
    asString(resultRecord?.summary) ??
    asString(resultRecord?.output) ??
    undefined;

  const verification: TaskVerificationRecord = {
    status: normalizeVerificationStatus(
      explicitVerification?.status,
      evaluation.success ? (evaluation.outcome === "ambiguous" ? "ambiguous" : "passed") : "failed",
    ),
    strategy: normalizeVerificationStrategy(
      explicitVerification?.strategy ?? evaluation.strategy,
      evaluation.strategy ?? (typeof result === "string" ? "structural" : "deterministic"),
    ),
    contract: task.verificationHint?.contract ?? (evaluation.contract as TaskVerificationRecord["contract"]),
    summary,
  };

  task.verification = verification;
  return verification;
}

function applyRecovery(
  task: Task,
  fallbackAction: TaskRecoveryRecord["action"],
  reason?: string,
): TaskRecoveryRecord {
  const resultRecord = extractRecord(task.result);
  const explicitRecovery = extractRecord(resultRecord?.recovery);
  const retryBudget = getRetryBudget(task);
  const retryCount = getRetryCount(task);
  const previousReason = task.recovery?.lastFailureReason;
  const normalizedReason = asString(reason) ?? asString(resultRecord?.reason) ?? asString(resultRecord?.message);
  const repeatCount = normalizedReason && previousReason && normalizedReason === previousReason
    ? (task.recovery?.repeatCount ?? 1) + 1
    : normalizedReason
      ? 1
      : task.recovery?.repeatCount;

  const recovery: TaskRecoveryRecord = {
    action: normalizeRecoveryAction(explicitRecovery?.action, fallbackAction),
    reason:
      asString(explicitRecovery?.reason) ??
      asString(reason) ??
      asString(resultRecord?.reason) ??
      asString(resultRecord?.message) ??
      undefined,
    retryBudget: asNumber(explicitRecovery?.retryBudget) ?? retryBudget,
    retryCount: asNumber(explicitRecovery?.retryCount) ?? retryCount,
    repeatCount: asNumber(explicitRecovery?.repeatCount) ?? repeatCount,
    lastFailureReason: asString(explicitRecovery?.lastFailureReason) ?? normalizedReason ?? previousReason,
    failureClass: task.status === "failed" || task.status === "blocked" || task.status === "needs_user" || task.status === "aborted"
      ? task.status
      : undefined,
  };

  task.recovery = recovery;
  task.nextAction = recovery.action;
  return recovery;
}

function createDependencyFailure(dependsOn: string, dependencyStatus?: TaskStatus): EvaluationResult {
  return {
    success: false,
    outcome: "failure",
    reason: dependencyStatus
      ? `dependency ${dependsOn} is ${dependencyStatus}`
      : `dependency ${dependsOn} was not completed`,
  };
}

function hasCompletedDependency(task: Task, taskMap: Map<string, Task>): { ok: boolean; missing?: string; dependency?: Task } {
  for (const dependencyId of task.dependsOn) {
    const dependency = taskMap.get(dependencyId);
    if (!dependency || (dependency.status !== "completed" && dependency.status !== "verified")) {
      return { ok: false, missing: dependencyId, dependency };
    }
  }

  return { ok: true };
}

function filterReplannedTasks(currentTasks: Task[], currentIndex: number, replannedPlan: Plan): Task[] {
  const blockedIds = new Set(currentTasks.slice(0, currentIndex).map((task) => task.id));
  const seen = new Set<string>();
  const nextTasks: Task[] = [];

  for (const task of replannedPlan.tasks) {
    if (blockedIds.has(task.id) || seen.has(task.id)) {
      continue;
    }

    seen.add(task.id);
    nextTasks.push(cloneTask(task));
  }

  return nextTasks;
}

async function maybeReplan(
  currentPlan: Plan,
  tasks: Task[],
  currentIndex: number,
  failedTask: Task,
  failedStep: PlanExecutionStep,
  context: AppState,
  steps: PlanExecutionStep[],
  replanner: Replanner | undefined,
  maxReplansPerTask: number,
  attemptsByTaskId: Map<string, number>,
): Promise<{ plan: Plan; tasks: Task[] } | null> {
  if (!replanner || maxReplansPerTask <= 0) {
    return null;
  }

  const attemptCount = attemptsByTaskId.get(failedTask.id) ?? 0;
  if (attemptCount >= maxReplansPerTask) {
    return null;
  }

  const request: ReplanRequest = {
    goal: currentPlan.goal,
    plan: clonePlan(currentPlan),
    failedTask: cloneTask(failedTask),
    failedStep,
    remainingTasks: tasks.slice(currentIndex + 1).map(cloneTask),
    context,
    steps: steps.map((step) => ({
      task: cloneTask(step.task),
      result: step.result,
      evaluation: { ...step.evaluation },
    })),
  };

  let response: ReplanResult | null;
  try {
    response = await replanner.replan(request);
  } catch {
    return null;
  }

  if (!response?.plan) {
    return null;
  }

  attemptsByTaskId.set(failedTask.id, attemptCount + 1);

  const nextTasks = filterReplannedTasks(tasks, currentIndex, response.plan);
  const mergedTasks = [...tasks.slice(0, currentIndex), ...nextTasks];

  return {
    plan: {
      goal: response.plan.goal,
      tasks: mergedTasks,
    },
    tasks: mergedTasks,
  };
}

function summarizePlan(plan: Plan, steps: PlanExecutionStep[]): PlanExecutionSummary {
  return {
    completed: plan.tasks.filter((task) => task.status === "completed" || task.status === "verified").length,
    failed: plan.tasks.filter((task) => task.status === "failed").length,
    ambiguous: steps.filter((step) => step.evaluation.outcome === "ambiguous").length,
  };
}

function isPlanComplete(tasks: Task[]): boolean {
  return tasks.every((task) => task.status === "completed" || task.status === "verified");
}

function finalizeCurrentRun(
  currentPlan: Plan,
  tasks: Task[],
  steps: PlanExecutionStep[],
): PlanExecutionResult {
  const summary = summarizePlan(currentPlan, steps);

  return {
    plan: {
      goal: currentPlan.goal,
      tasks,
    },
    steps,
    summary,
    completed: isPlanComplete(tasks),
  };
}

function classifySuccessfulTask(task: Task, evaluation: EvaluationResult): TaskStatus {
  void task;
  if (evaluation.outcome === "ambiguous") {
    return "verified";
  }

  if (evaluation.strategy === "deterministic") {
    return "completed";
  }

  return "verified";
}

export async function buildPlan(
  goal: string,
  context: AppState,
  planner: Planner = new BasicPlanner(),
): Promise<Plan> {
  return planner.plan(goal, context);
}

export async function executePlan(
  plan: Plan,
  context: AppState,
  options: PlanExecutionOptions,
): Promise<PlanExecutionResult> {
  const evaluator = options.evaluator ?? new BasicEvaluator();
  let currentPlan = clonePlan(plan);
  let tasks = currentPlan.tasks;
  let taskMap = rebuildTaskMap(tasks);
  const steps: PlanExecutionStep[] = [];
  const attemptsByTaskId = new Map<string, number>();

  let cursor = 0;
  while (cursor < tasks.length) {
    const task = tasks[cursor];

    if (task.status === "completed" || task.status === "verified") {
      if (!task.verification) {
        if (task.result !== undefined) {
          try {
            const verificationEvaluation = await evaluator.evaluate(task, task.result);
            applyVerification(task, verificationEvaluation, task.result);
            if (!task.recovery) {
              applyRecovery(task, "stop", verificationEvaluation.reason);
            }
          } catch {
            task.verification = {
              status: "passed",
              strategy: "structural",
              summary: "task completed before this run",
            };
            if (!task.recovery) {
              task.recovery = {
                action: "stop",
                reason: "task completed before this run",
                retryBudget: 0,
                retryCount: 0,
              };
              task.nextAction = "stop";
            }
          }
        } else {
          task.verification = {
            status: "passed",
            strategy: "structural",
            summary: "task completed before this run",
          };
          if (!task.recovery) {
            task.recovery = {
              action: "stop",
              reason: "task completed before this run",
              retryBudget: 0,
              retryCount: 0,
            };
            task.nextAction = "stop";
          }
        }
      }

      cursor += 1;
      continue;
    }

    const dependency = hasCompletedDependency(task, taskMap);
    if (!dependency.ok) {
      const dependencyStatus = dependency.dependency?.status;
      const evaluation = createDependencyFailure(dependency.missing ?? "(unknown)", dependencyStatus);
      task.status = "blocked";
      task.result = {
        blocked: true,
        dependencyId: dependency.missing,
        dependencyStatus,
        reason: evaluation.reason,
      };
      task.failureReason = evaluation.reason;
      applyVerification(task, evaluation, task.result);
      applyRecovery(task, dependencyStatus === "needs_user" ? "ask-user" : options.replanner ? "replan" : "stop", evaluation.reason);
      if (dependencyStatus === "needs_user") {
        task.nextAction = "ask-user";
      }
      const output = normalizeTaskOutput(task.result, evaluation);
      task.output = output;
      task.artifacts = output.artifacts;
      const step: PlanExecutionStep = {
        task: cloneTask(task),
        result: task.result,
        output,
        evaluation,
      };
      steps.push(step);
      options.onTaskEnd?.(step);

      if (dependencyStatus === "needs_user") {
        return finalizeCurrentRun(currentPlan, tasks, steps);
      }

      const replanned = await maybeReplan(
        currentPlan,
        tasks,
        cursor,
        task,
        step,
        context,
        steps,
        options.replanner,
        options.maxReplansPerTask ?? 1,
        attemptsByTaskId,
      );
      if (replanned) {
        currentPlan = replanned.plan;
        tasks = currentPlan.tasks;
        taskMap = rebuildTaskMap(tasks);
        continue;
      }

      cursor += 1;
      continue;
    }

    task.status = "running";
    options.onTaskStart?.(task);
    let result: unknown;
    try {
      result = await options.runTask(task, context, buildExecutionContext(steps));
    } catch (error) {
      result = error instanceof Error ? error : new Error(String(error));
    }

    const evaluation = await evaluator.evaluate(task, result);
    task.result = result;
    const retryBudget = getRetryBudget(task);
    const retryCount = getRetryCount(task);
    const disposition = inferFailureDisposition(result, evaluation, Boolean(options.replanner));

    if (evaluation.success) {
      task.status = classifySuccessfulTask(task, evaluation);
      task.failureReason = undefined;
      applyVerification(task, evaluation, result);
      applyRecovery(task, "stop", evaluation.reason);
      const output = normalizeTaskOutput(result, evaluation);
      task.output = output;
      task.artifacts = output.artifacts;

      const step: PlanExecutionStep = {
        task: cloneTask(task),
        result,
        output,
        evaluation,
      };
      steps.push(step);
      options.onTaskEnd?.(step);
      cursor += 1;
      continue;
    }

    task.status = disposition.status;
    task.failureReason = evaluation.reason;
    applyVerification(task, evaluation, result);
    const output = normalizeTaskOutput(result, evaluation);
    task.output = output;
    task.artifacts = output.artifacts;

    if (disposition.status === "needs_user") {
      task.recovery = {
        action: "ask-user",
        reason: evaluation.reason,
        retryBudget,
        retryCount,
      };
      task.nextAction = "ask-user";

      const step: PlanExecutionStep = {
        task: cloneTask(task),
        result,
        output,
        evaluation,
      };
      steps.push(step);
      options.onTaskEnd?.(step);
      return finalizeCurrentRun(currentPlan, tasks, steps);
    }

    // Policy: local retry budget is always exhausted before any replanner call.
    // Replan attempts are a separate tail-repair budget that only starts after
    // inline retries are no longer available for a task.
    if (disposition.status === "failed" && retryCount < retryBudget) {
      task.recovery = {
        action: "retry",
        reason: evaluation.reason,
        retryBudget,
        retryCount: retryCount + 1,
      };
      task.nextAction = "retry";

      const step: PlanExecutionStep = {
        task: cloneTask(task),
        result,
        output,
        evaluation,
      };
      steps.push(step);
      options.onTaskEnd?.(step);

      task.status = "pending";
      task.result = undefined;
      task.output = undefined;
      task.artifacts = undefined;
      task.failureReason = undefined;
      continue;
    }

    applyRecovery(task, disposition.recoveryAction, evaluation.reason);
    task.nextAction = disposition.nextAction ?? task.nextAction;

    const step: PlanExecutionStep = {
      task: cloneTask(task),
      result,
      output,
      evaluation,
    };
    steps.push(step);
    options.onTaskEnd?.(step);

    if (options.replanner && disposition.recoveryAction === "replan") {
      const replanned = await maybeReplan(
        currentPlan,
        tasks,
        cursor,
        task,
        step,
        context,
        steps,
        options.replanner,
        options.maxReplansPerTask ?? 1,
        attemptsByTaskId,
      );
      if (replanned) {
        currentPlan = replanned.plan;
        tasks = currentPlan.tasks;
        taskMap = rebuildTaskMap(tasks);
        continue;
      }
    }

    cursor += 1;
  }

  return finalizeCurrentRun(currentPlan, tasks, steps);
}

export async function planAndExecute(
  goal: string,
  context: AppState,
  options: PlanExecutionOptions,
): Promise<PlanExecutionResult> {
  const planner = options.planner ?? new BasicPlanner();
  const plan = await planner.plan(goal, context);
  return executePlan(plan, context, options);
}
