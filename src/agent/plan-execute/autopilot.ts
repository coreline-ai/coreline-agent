import type { AppState } from "../context.js";
import { BasicPlanner } from "./planner.js";
import type {
  AutopilotDecisionKind,
  AutopilotDecisionRecord,
  Plan,
  Planner,
  Task,
} from "./types.js";
import type { PlanExecutionOptions, PlanExecutionResult } from "./runner.js";
import { buildPlan, executePlan } from "./runner.js";
import {
  createAutopilotLoopGuard,
  summarizeAutopilotSnapshot,
  type AutopilotGuardDecision,
  type AutopilotLoopGuardOptions,
} from "./autopilot-loop-guard.js";

export interface AutopilotResumeState {
  plan?: Plan;
  cycleCount?: number;
  decisionLog?: AutopilotDecisionRecord[];
}

export interface AutopilotDecisionEvent {
  cycle: number;
  decision: AutopilotDecisionRecord;
}

export interface AutopilotCycleEvent {
  cycle: number;
  plan: Plan;
  decisionLog: AutopilotDecisionRecord[];
}

export interface AutopilotOptions extends Omit<PlanExecutionOptions, "planner"> {
  planner?: Planner;
  resumeState?: AutopilotResumeState;
  maxCycles?: number;
  loopGuardOptions?: AutopilotLoopGuardOptions;
  onDecision?: (event: AutopilotDecisionEvent) => void;
  onCycleStart?: (event: AutopilotCycleEvent) => void;
  onCycleEnd?: (event: AutopilotCycleEvent & { result: PlanExecutionResult; stopStatus: AutopilotStopStatus }) => void;
}

export interface AutopilotRunResult {
  result: PlanExecutionResult;
  latestPlan: Plan;
  cycleCount: number;
  stopStatus: AutopilotStopStatus;
  stopReason: string;
  decisionLog: AutopilotDecisionRecord[];
  activeTaskId?: string;
}

type AutopilotStopStatus = "running" | "completed" | "failed" | "aborted" | "blocked" | "needs_user";

function cloneTask(task: Task): Task {
  return {
    ...task,
    dependsOn: [...task.dependsOn],
    output: task.output
      ? {
          ...task.output,
          artifacts: task.output.artifacts ? task.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
        }
      : undefined,
    artifacts: task.artifacts ? task.artifacts.map((artifact) => ({ ...artifact })) : undefined,
    verificationHint: task.verificationHint ? { ...task.verificationHint } : undefined,
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

function cloneDecision(entry: AutopilotDecisionRecord): AutopilotDecisionRecord {
  return { ...entry };
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDecision(
  cycle: number,
  kind: AutopilotDecisionKind,
  reason: string,
  taskId?: string,
  progress?: string,
  guard?: AutopilotGuardDecision,
): AutopilotDecisionRecord {
  return {
    cycle,
    kind,
    reason,
    createdAt: nowIso(),
    taskId,
    guardKind: guard?.kind,
    progress,
  };
}

function appendDecision(
  log: AutopilotDecisionRecord[],
  decision: AutopilotDecisionRecord,
  onDecision?: (event: AutopilotDecisionEvent) => void,
): AutopilotDecisionRecord[] {
  const next = [...log, decision];
  onDecision?.({ cycle: decision.cycle, decision });
  return next;
}

function deriveStopStatus(result: PlanExecutionResult): AutopilotStopStatus {
  if (result.plan.tasks.some((task) => task.status === "needs_user")) return "needs_user";
  if (result.plan.tasks.some((task) => task.status === "blocked")) return "blocked";
  if (result.plan.tasks.some((task) => task.status === "aborted")) return "aborted";
  if (result.completed) return "completed";
  if (result.plan.tasks.some((task) => task.status === "failed")) return "failed";
  return "running";
}

function findActiveTaskId(plan: Plan): string | undefined {
  return plan.tasks.find((task) => task.status !== "completed" && task.status !== "verified")?.id;
}

function buildContinuationGoal(goal: string, result: PlanExecutionResult, decisionLog: AutopilotDecisionRecord[]): string {
  const completed = result.plan.tasks.filter((task) => task.status === "completed" || task.status === "verified");
  const remaining = result.plan.tasks.filter((task) => task.status !== "completed" && task.status !== "verified");
  const latestStep = [...result.steps].reverse().find((step) => step.result !== undefined || step.evaluation !== undefined);
  const completedText = completed.length > 0
    ? completed.map((task) => `- ${task.id}: ${task.output?.summary ?? task.verification?.summary ?? task.description}`).join("\n")
    : "- none yet";
  const remainingText = remaining.length > 0
    ? remaining.map((task) => `- ${task.id}: ${task.description} [${task.status}]`).join("\n")
    : "- none";
  const latestReason = latestStep?.task.failureReason ?? latestStep?.task.recovery?.reason ?? latestStep?.evaluation?.reason ?? "n/a";
  const recentDecisions = decisionLog.slice(-3).map((entry) => `- cycle ${entry.cycle}: ${entry.kind} — ${entry.reason}`).join("\n") || "- none";

  return [
    goal,
    "",
    "Autopilot continuation context:",
    "Completed and verified work:",
    completedText,
    "",
    "Remaining or unfinished work:",
    remainingText,
    "",
    `Latest stop reason: ${latestReason}`,
    "Recent decisions:",
    recentDecisions,
    "",
    "Create a next plan for only the unfinished work.",
  ].join("\n");
}

export async function runAutopilot(goal: string, context: AppState, options: AutopilotOptions): Promise<AutopilotRunResult> {
  const planner = options.planner ?? new BasicPlanner();
  const maxCycles = Math.max(1, options.maxCycles ?? 4);
  const guard = createAutopilotLoopGuard(options.loopGuardOptions);

  let currentPlan = options.resumeState?.plan ? clonePlan(options.resumeState.plan) : await buildPlan(goal, context, planner);
  let cycleCount = options.resumeState?.cycleCount ?? 0;
  let decisionLog = (options.resumeState?.decisionLog ?? []).map(cloneDecision);
  let lastResult: PlanExecutionResult | null = null;

  decisionLog = appendDecision(
    decisionLog,
    createDecision(
      cycleCount,
      options.resumeState?.plan ? "resume" : "start",
      options.resumeState?.plan ? "resume autopilot from saved plan state" : "start autopilot from goal input",
      findActiveTaskId(currentPlan),
    ),
    options.onDecision,
  );

  while (cycleCount < maxCycles) {
    cycleCount += 1;
    options.onCycleStart?.({ cycle: cycleCount, plan: clonePlan(currentPlan), decisionLog: decisionLog.map(cloneDecision) });

    const result = await executePlan(currentPlan, context, {
      ...options,
      planner,
      runTask: options.runTask,
    });
    lastResult = result;
    const stopStatus = deriveStopStatus(result);
    options.onCycleEnd?.({ cycle: cycleCount, plan: clonePlan(result.plan), decisionLog: decisionLog.map(cloneDecision), result, stopStatus });

    if (stopStatus === "completed") {
      const stopReason = "goal completed and verified";
      decisionLog = appendDecision(decisionLog, createDecision(cycleCount, "stop", stopReason, findActiveTaskId(result.plan)), options.onDecision);
      return { result, latestPlan: clonePlan(result.plan), cycleCount, stopStatus, stopReason, decisionLog, activeTaskId: findActiveTaskId(result.plan) };
    }

    if (stopStatus === "needs_user" || stopStatus === "blocked" || stopStatus === "aborted") {
      const latestStep = [...result.steps].reverse().find((step) => step.result !== undefined || step.evaluation !== undefined);
      const stopReason = latestStep?.task.failureReason ?? latestStep?.task.recovery?.reason ?? latestStep?.evaluation?.reason ?? `autopilot stopped with status ${stopStatus}`;
      decisionLog = appendDecision(decisionLog, createDecision(cycleCount, "stop", stopReason, latestStep?.task.id ?? findActiveTaskId(result.plan)), options.onDecision);
      return { result, latestPlan: clonePlan(result.plan), cycleCount, stopStatus, stopReason, decisionLog, activeTaskId: findActiveTaskId(result.plan) };
    }

    const snapshot = { ...summarizeAutopilotSnapshot(result), cycle: cycleCount };
    const guardDecision = guard.check(snapshot);
    if (guardDecision.triggered) {
      const stopReason = guardDecision.reason ?? "autopilot loop guard triggered";
      decisionLog = appendDecision(
        decisionLog,
        createDecision(cycleCount, "stop", stopReason, snapshot.activeTaskId, `${snapshot.summary.completed}/${snapshot.summary.failed}/${snapshot.summary.ambiguous}`, guardDecision),
        options.onDecision,
      );
      return {
        result,
        latestPlan: clonePlan(result.plan),
        cycleCount,
        stopStatus: guardDecision.suggestedStatus ?? "blocked",
        stopReason,
        decisionLog,
        activeTaskId: snapshot.activeTaskId,
      };
    }

    const latestStep = [...result.steps].reverse().find((step) => step.result !== undefined || step.evaluation !== undefined);
    const nextDecisionKind: AutopilotDecisionKind = latestStep?.task.recovery?.action === "retry"
      ? "retry"
      : latestStep?.task.recovery?.action === "replan"
        ? "replan"
        : "continue-next-task";
    const nextReason = latestStep?.task.recovery?.reason
      ?? latestStep?.task.failureReason
      ?? latestStep?.evaluation?.reason
      ?? "continue the remaining work with a refreshed plan";
    decisionLog = appendDecision(
      decisionLog,
      createDecision(cycleCount, nextDecisionKind, nextReason, latestStep?.task.id ?? snapshot.activeTaskId, `${snapshot.summary.completed}/${snapshot.summary.failed}/${snapshot.summary.ambiguous}`),
      options.onDecision,
    );

    currentPlan = await buildPlan(buildContinuationGoal(goal, result, decisionLog), context, planner);
  }

  const result = lastResult ?? await executePlan(currentPlan, context, { ...options, planner, runTask: options.runTask });
  const stopReason = `autopilot reached max cycles (${maxCycles}) without terminal completion`;
  decisionLog = appendDecision(
    decisionLog,
    createDecision(cycleCount, "stop", stopReason, findActiveTaskId(result.plan), undefined, {
      triggered: true,
      kind: "max_cycles",
      suggestedStatus: "blocked",
      reason: stopReason,
    }),
    options.onDecision,
  );

  return {
    result,
    latestPlan: clonePlan(result.plan),
    cycleCount,
    stopStatus: "blocked",
    stopReason,
    decisionLog,
    activeTaskId: findActiveTaskId(result.plan),
  };
}
