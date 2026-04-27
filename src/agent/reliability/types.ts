/**
 * Single-agent reliability contracts.
 *
 * Source-of-truth rule:
 * - Existing plan/session/autopilot records remain the canonical state.
 * - Types in this module are derived summaries, adapters, and evidence bundles.
 * - They must not replace Task.status, PlanRunRecord.status, EvaluationResult,
 *   TaskVerification, TaskRecovery, or AutopilotDecisionRecord.
 */

export type AgentRunOutcome = "completed" | "partial" | "blocked" | "needs_user" | "failed" | "aborted" | "unknown";
export type CompletionConfidence = "high" | "medium" | "low";

export type ReliabilityEvidenceKind =
  | "task"
  | "verification"
  | "evaluation"
  | "tool_result"
  | "permission"
  | "hook"
  | "trace"
  | "plan_run"
  | "external";

export interface ReliabilityEvidence {
  kind: ReliabilityEvidenceKind;
  summary: string;
  taskId?: string;
  toolUseId?: string;
  status?: string;
  detail?: string;
}

export interface CompletionDecision {
  outcome: AgentRunOutcome;
  confidence: CompletionConfidence;
  reason: string;
  evidence: ReliabilityEvidence[];
  missingEvidence: string[];
  recommendedNextAction?: string;
}

export type AgentTraceEventKind =
  | "tool_planned"
  | "tool_executed"
  | "tool_failed"
  | "permission_allow"
  | "permission_ask"
  | "permission_deny"
  | "hook_blocking"
  | "hook_error"
  | "evaluator_decision"
  | "completion_decision"
  | "recovery_checkpoint_created"
  | "recovery_resumed"
  | "verification_evidence";

export interface AgentTraceEvent {
  eventKind: AgentTraceEventKind;
  reason?: string;
  toolName?: string;
  toolUseId?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTraceRecord extends AgentTraceEvent {
  _type: "agent_trace";
  traceId: string;
  sessionId: string;
  timestamp: string;
}

export interface DoNotRepeatAdvice {
  taskId?: string;
  toolUseId?: string;
  reason: string;
  evidence?: string;
}

export interface RecoveryCheckpoint {
  checkpointId: string;
  sessionId: string;
  createdAt: string;
  planRunId?: string;
  completedTaskIds: string[];
  activeTaskId?: string;
  lastSuccessfulToolUseId?: string;
  failedToolUseId?: string;
  failureReason?: string;
  doNotRepeat: DoNotRepeatAdvice[];
  suggestedNextAction: string;
}

export type ResumeAdviceAction = "continue" | "retry" | "replan" | "ask_user" | "stop" | "unknown";
export type ResumeRisk = "low" | "medium" | "high";

export interface ResumeAdvice {
  checkpointId?: string;
  action: ResumeAdviceAction;
  risk: ResumeRisk;
  reason: string;
  fromTaskId?: string;
  doNotRepeat: DoNotRepeatAdvice[];
  suggestedNextAction?: string;
}

export type VerificationEvidenceStatus = "passed" | "failed" | "not_run" | "not_applicable" | "ambiguous";

export interface VerificationEvidence {
  kind: ReliabilityEvidenceKind;
  status: VerificationEvidenceStatus;
  summary: string;
  sourceId?: string;
  taskId?: string;
  toolUseId?: string;
  detail?: string;
}

export interface VerificationPack {
  packId: string;
  createdAt: string;
  status: VerificationEvidenceStatus;
  summary: string;
  evidence: VerificationEvidence[];
  missingEvidence: string[];
}
