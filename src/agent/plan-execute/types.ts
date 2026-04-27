import type { AppState } from "../context.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "needs_user"
  | "failed"
  | "verified"
  | "completed"
  | "aborted";
export type EvaluationOutcome = "success" | "failure" | "ambiguous";
export type VerificationContract = "exit_code" | "artifact" | "assertion";
export type VerificationStrategy = "deterministic" | "structural" | "llm";
export type VerificationStatus = "pending" | "passed" | "failed" | "ambiguous";
export type RecoveryAction = "retry" | "replan" | "ask-user" | "stop";
export type TaskArtifactKind = "summary" | "file" | "path" | "output" | "verification";
export type AutopilotDecisionKind =
  | "start"
  | "resume"
  | "continue-next-task"
  | "retry"
  | "replan"
  | "stop";
export type AutopilotGuardKind = "repeated_failure" | "repeated_tail" | "no_progress" | "max_cycles";

export interface AutopilotDecisionRecord {
  cycle: number;
  kind: AutopilotDecisionKind;
  reason: string;
  createdAt: string;
  taskId?: string;
  guardKind?: AutopilotGuardKind;
  progress?: string;
}

export interface TaskArtifact {
  kind: TaskArtifactKind;
  label: string;
  value: string;
}

export interface TaskOutput {
  summary?: string;
  finalText?: string;
  artifacts?: TaskArtifact[];
  verificationSummary?: string;
}

export interface VerificationHint {
  contract: VerificationContract;
  expectedExitCode?: number;
  artifactKind?: TaskArtifactKind;
  artifactLabel?: string;
  assertionText?: string;
  assertionPattern?: string;
  assertionTarget?: "result" | "summary" | "finalText";
}

export interface TaskVerification {
  status: VerificationStatus;
  strategy: VerificationStrategy;
  contract?: VerificationContract;
  summary?: string;
}

export interface TaskRecovery {
  action?: RecoveryAction;
  reason?: string;
  retryCount?: number;
  retryBudget?: number;
  repeatCount?: number;
  lastFailureReason?: string;
  failureClass?: Extract<TaskStatus, "failed" | "blocked" | "needs_user" | "aborted">;
}

export interface Task {
  id: string;
  description: string;
  dependsOn: string[];
  status: TaskStatus;
  result?: unknown;
  output?: TaskOutput;
  artifacts?: TaskArtifact[];
  verificationHint?: VerificationHint;
  failureReason?: string;
  nextAction?: string;
  verification?: TaskVerification;
  recovery?: TaskRecovery;
}

export interface PlanExecutionStep {
  task: Task;
  result: unknown;
  output?: TaskOutput;
  evaluation: EvaluationResult;
}

export interface Plan {
  goal: string;
  tasks: Task[];
}

export interface EvaluationResult {
  success: boolean;
  outcome: EvaluationOutcome;
  reason?: string;
  strategy?: VerificationStrategy;
  contract?: VerificationContract;
}

export interface PlanExecutionContext {
  completedSteps: PlanExecutionStep[];
  completedOutputs: Map<string, TaskOutput>;
}

export interface Planner {
  plan(goal: string, context: AppState): Promise<Plan>;
}

export interface Evaluator {
  evaluate(task: Task, result: unknown): Promise<EvaluationResult>;
}

export interface PlanExecuteConfig {
  planner?: Planner;
  evaluator?: Evaluator;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed"
    || status === "verified"
    || status === "blocked"
    || status === "needs_user"
    || status === "failed"
    || status === "aborted";
}
