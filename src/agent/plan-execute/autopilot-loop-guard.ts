import type { PlanExecutionResult, PlanExecutionSummary } from "./runner.js";
import type { AutopilotGuardKind } from "./types.js";

type AutopilotGuardStatus = "running" | "completed" | "failed" | "aborted" | "blocked" | "needs_user";

export interface AutopilotGuardSnapshot {
  cycle: number;
  summary: PlanExecutionSummary;
  status: AutopilotGuardStatus;
  activeTaskId?: string;
  failureReason?: string;
  verificationSummary?: string;
  tailTaskIds: string[];
}

export interface AutopilotGuardDecision {
  triggered: boolean;
  kind?: AutopilotGuardKind;
  suggestedStatus?: Extract<AutopilotGuardStatus, "blocked" | "needs_user" | "failed">;
  reason?: string;
}

export interface AutopilotLoopGuardOptions {
  repeatedFailureLimit?: number;
  repeatedTailLimit?: number;
  noProgressLimit?: number;
}

type GuardState = {
  lastFailureFingerprint?: string;
  repeatedFailureCount: number;
  lastTailFingerprint?: string;
  repeatedTailCount: number;
  lastProgressFingerprint?: string;
  noProgressCount: number;
};

function makeFailureFingerprint(snapshot: AutopilotGuardSnapshot): string | null {
  const reason = snapshot.failureReason?.trim() || snapshot.verificationSummary?.trim();
  if (!reason) return null;
  return `${snapshot.activeTaskId ?? "(none)"}:${reason}`;
}

function makeTailFingerprint(snapshot: AutopilotGuardSnapshot): string | null {
  if (snapshot.tailTaskIds.length === 0) return null;
  return snapshot.tailTaskIds.join("|");
}

function makeProgressFingerprint(snapshot: AutopilotGuardSnapshot): string {
  return [
    snapshot.summary.completed,
    snapshot.summary.failed,
    snapshot.summary.ambiguous,
    snapshot.activeTaskId ?? "(none)",
    snapshot.tailTaskIds.join("|"),
  ].join(":");
}

export function summarizeAutopilotSnapshot(result: PlanExecutionResult): AutopilotGuardSnapshot {
  const activeTaskId = result.plan.tasks.find((task) => task.status !== "completed" && task.status !== "verified")?.id;
  const lastStep = [...result.steps].reverse().find((step) => step.result !== undefined || step.evaluation !== undefined);
  const status: AutopilotGuardStatus = result.plan.tasks.some((task) => task.status === "needs_user")
    ? "needs_user"
    : result.plan.tasks.some((task) => task.status === "blocked")
      ? "blocked"
      : result.plan.tasks.some((task) => task.status === "aborted")
        ? "aborted"
        : result.completed
          ? "completed"
          : result.plan.tasks.some((task) => task.status === "failed")
            ? "failed"
            : "running";

  return {
    cycle: 0,
    summary: result.summary,
    status,
    activeTaskId,
    failureReason: lastStep?.task.failureReason ?? lastStep?.task.recovery?.lastFailureReason ?? lastStep?.evaluation?.reason,
    verificationSummary: lastStep?.task.verification?.summary ?? lastStep?.output?.verificationSummary ?? lastStep?.output?.summary,
    tailTaskIds: result.plan.tasks
      .filter((task) => task.status !== "completed" && task.status !== "verified")
      .map((task) => task.id),
  };
}

export function createAutopilotLoopGuard(options: AutopilotLoopGuardOptions = {}) {
  const repeatedFailureLimit = Math.max(2, options.repeatedFailureLimit ?? 2);
  const repeatedTailLimit = Math.max(2, options.repeatedTailLimit ?? 2);
  const noProgressLimit = Math.max(2, options.noProgressLimit ?? 2);

  const state: GuardState = {
    repeatedFailureCount: 0,
    repeatedTailCount: 0,
    noProgressCount: 0,
  };

  return {
    check(snapshot: AutopilotGuardSnapshot): AutopilotGuardDecision {
      const failureFingerprint = makeFailureFingerprint(snapshot);
      if (failureFingerprint) {
        state.repeatedFailureCount = state.lastFailureFingerprint === failureFingerprint
          ? state.repeatedFailureCount + 1
          : 1;
        state.lastFailureFingerprint = failureFingerprint;

        if (state.repeatedFailureCount >= repeatedFailureLimit) {
          return {
            triggered: true,
            kind: "repeated_failure",
            suggestedStatus: snapshot.status === "needs_user" ? "needs_user" : "blocked",
            reason: `same failure repeated ${state.repeatedFailureCount} times for ${snapshot.activeTaskId ?? "the active task"}`,
          };
        }
      }

      const tailFingerprint = makeTailFingerprint(snapshot);
      if (tailFingerprint) {
        state.repeatedTailCount = state.lastTailFingerprint === tailFingerprint
          ? state.repeatedTailCount + 1
          : 1;
        state.lastTailFingerprint = tailFingerprint;

        if (state.repeatedTailCount >= repeatedTailLimit) {
          return {
            triggered: true,
            kind: "repeated_tail",
            suggestedStatus: "blocked",
            reason: `same remaining task tail repeated ${state.repeatedTailCount} times`,
          };
        }
      }

      const progressFingerprint = makeProgressFingerprint(snapshot);
      state.noProgressCount = state.lastProgressFingerprint === progressFingerprint
        ? state.noProgressCount + 1
        : 1;
      state.lastProgressFingerprint = progressFingerprint;

      if (state.noProgressCount >= noProgressLimit) {
        return {
          triggered: true,
          kind: "no_progress",
          suggestedStatus: snapshot.status === "needs_user" ? "needs_user" : "blocked",
          reason: `no measurable progress across ${state.noProgressCount} consecutive autopilot cycles`,
        };
      }

      return { triggered: false };
    },
  };
}
