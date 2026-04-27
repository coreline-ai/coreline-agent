/**
 * Session Records — shared JSONL entry shapes for session persistence.
 *
 * Regular chat messages are still stored as raw ChatMessage JSON for
 * backward compatibility. Structured records use a `_type` envelope.
 */

import type { ChatMessage, Usage } from "../agent/types.js";
import type {
  AgentTraceEventKind,
  AgentTraceRecord,
  CompletionDecision,
  RecoveryCheckpoint,
  ResumeAdvice,
  VerificationPack,
} from "../agent/reliability/types.js";
import { isTranscriptEntryRecord, type TranscriptEntryRecord } from "./transcript.js";
import type {
  AutopilotDecisionKind,
  AutopilotDecisionRecord,
  AutopilotGuardKind,
  EvaluationResult,
  Plan,
  RecoveryAction,
  Task,
  TaskArtifact,
  TaskStatus,
  TaskOutput,
  VerificationContract,
  VerificationHint,
  VerificationStatus,
  VerificationStrategy,
} from "../agent/plan-execute/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionHeaderRecord {
  _type: "session_header";
  sessionId: string;
  createdAt: string;
  provider?: string;
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}

export type SubAgentRunStatus = "started" | "completed" | "error" | "aborted";

export interface PlanStepRecord {
  task: Task;
  result?: unknown;
  output?: TaskOutput;
  evaluation?: EvaluationResult;
}

export type SubAgentResultKind = "single" | "child" | "coordinator";

export interface SubAgentArtifact {
  kind: "summary" | "final_text" | "tools" | "status" | "failure";
  label: string;
  value: string;
}

export type PlanRunStatus = "running" | "completed" | "failed" | "aborted" | "blocked" | "needs_user";
export type PlanRunMode = "plan" | "goal" | "autopilot";

export interface PlanRunRecord {
  _type: "plan_run";
  planRunId: string;
  sessionId: string;
  createdAt: string;
  mode?: PlanRunMode;
  source?: "cli" | "tui";
  cwd?: string;
  providerName?: string;
  model?: string;
  prompt?: string;
  goal: string;
  activeTaskId?: string;
  nextAction?: string;
  recoveryAction?: RecoveryAction;
  resumeEligible?: boolean;
  lastVerificationSummary?: string;
  lastFailureClass?: Extract<TaskStatus, "failed" | "blocked" | "needs_user" | "aborted">;
  lastFailureReason?: string;
  lastRecoveryRationale?: string;
  cycleCount?: number;
  stopReason?: string;
  decisionLog?: AutopilotDecisionRecord[];
  /** Derived reliability summary. Existing plan/task fields remain the source of truth. */
  completionDecision?: CompletionDecision;
  /** Derived verification evidence bundle. This is a report artifact, not an executor. */
  verificationPack?: VerificationPack;
  /** Derived recovery checkpoint. Advisory only; it must not block execution by itself. */
  recoveryCheckpoint?: RecoveryCheckpoint;
  /** Derived resume recommendation. Advisory only. */
  resumeAdvice?: ResumeAdvice;
  plan: Plan;
  steps: PlanStepRecord[];
  summary?: {
    completed: number;
    failed: number;
    ambiguous: number;
    verified?: number;
  };
  completed?: boolean;
  status?: PlanRunStatus;
  resultText?: string;
  error?: string;
  [key: string]: unknown;
}

export interface SubAgentRunRecord {
  _type: "sub_agent_run";
  childId: string;
  sessionId: string;
  createdAt: string;
  parentToolUseId?: string;
  parentMessageIndex?: number;
  cwd?: string;
  providerName?: string;
  model?: string;
  agentDepth?: number;
  usedTools?: string[];
  prompt?: string;
  summary?: string;
  finalText?: string;
  turns?: number;
  usage?: Usage;
  success?: boolean;
  status?: SubAgentRunStatus;
  error?: string;
  transcript?: ChatMessage[];
  resultKind?: SubAgentResultKind;
  childCount?: number;
  completedCount?: number;
  failedCount?: number;
  partial?: boolean;
  artifacts?: SubAgentArtifact[];
  displayTitle?: string;
  displaySummary?: string;
  [key: string]: unknown;
}

export type ChildExecutionRecord = SubAgentRunRecord;
export type SessionStructuredRecord = SessionHeaderRecord | SubAgentRunRecord | PlanRunRecord | TranscriptEntryRecord | AgentTraceRecord;

export type ParsedSessionLine =
  | { kind: "message"; message: ChatMessage }
  | { kind: "structured"; record: SessionStructuredRecord }
  | { kind: "unknown" };

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || typeof value.role !== "string") return false;

  if (value.role === "system") {
    return typeof value.content === "string";
  }

  if (value.role === "user") {
    return typeof value.content === "string" || Array.isArray(value.content);
  }

  if (value.role === "assistant") {
    return Array.isArray(value.content);
  }

  return false;
}

export function isSessionHeaderRecord(value: unknown): value is SessionHeaderRecord {
  return isRecord(value) && value._type === "session_header" && typeof value.sessionId === "string";
}

export function isSubAgentRunRecord(value: unknown): value is SubAgentRunRecord {
  return isRecord(value)
    && value._type === "sub_agent_run"
    && typeof value.childId === "string"
    && typeof value.sessionId === "string"
    && typeof value.createdAt === "string";
}

export function isPlanRunRecord(value: unknown): value is PlanRunRecord {
  return isRecord(value)
    && value._type === "plan_run"
    && typeof value.planRunId === "string"
    && typeof value.sessionId === "string"
    && typeof value.createdAt === "string"
    && typeof value.goal === "string"
    && isRecord(value.plan)
    && Array.isArray(value.steps);
}

export function isAgentTraceRecord(value: unknown): value is AgentTraceRecord {
  return isRecord(value)
    && value._type === "agent_trace"
    && typeof value.traceId === "string"
    && typeof value.sessionId === "string"
    && typeof value.timestamp === "string"
    && isAgentTraceEventKind(value.eventKind);
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function createSessionHeaderRecord(
  sessionId: string,
  metadata: Record<string, unknown>,
): SessionHeaderRecord {
  return {
    _type: "session_header",
    sessionId,
    createdAt: new Date().toISOString(),
    ...metadata,
  };
}

export function createSubAgentRunRecord(
  record: Omit<SubAgentRunRecord, "_type" | "createdAt" | "childId"> & {
    childId?: string;
    id?: string;
    createdAt?: string;
  },
): SubAgentRunRecord {
  const childId = record.childId ?? record.id;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  if (!childId) {
    throw new Error("childId is required for sub-agent run records");
  }
  if (!sessionId) {
    throw new Error("sessionId is required for sub-agent run records");
  }

  const { id: _legacyId, childId: _legacyChildId, sessionId: _legacySessionId, createdAt, ...rest } = record;

  return {
    _type: "sub_agent_run",
    childId,
    sessionId,
    createdAt: createdAt ?? new Date().toISOString(),
    ...rest,
  };
}

// Backward-compatible alias.
export const createChildExecutionRecord = createSubAgentRunRecord;

// ---------------------------------------------------------------------------
// Plan run records
// ---------------------------------------------------------------------------

function normalizePlanTask(value: unknown, fallbackId: string): Task | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : fallbackId;
  const description = typeof value.description === "string" && value.description.trim().length > 0
    ? value.description.trim()
    : typeof value.title === "string" && value.title.trim().length > 0
      ? value.title.trim()
      : null;

  if (!description) {
    return null;
  }

  const dependsOn = Array.isArray(value.dependsOn)
    ? value.dependsOn.filter((entry): entry is string => typeof entry === "string")
    : [];

  const status = normalizeTaskStatus(value.status);

  return {
    id,
    description,
    dependsOn,
    status,
    result: value.result,
    output: normalizeTaskOutput(value.output),
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.map(normalizeTaskArtifact).filter((entry): entry is TaskArtifact => Boolean(entry))
      : undefined,
    verificationHint: normalizeVerificationHint(value.verificationHint),
    failureReason: typeof value.failureReason === "string"
      ? value.failureReason
      : typeof value.reason === "string"
        ? value.reason
        : undefined,
    nextAction: typeof value.nextAction === "string" ? value.nextAction : undefined,
    verification: normalizeTaskVerification(value.verification),
    recovery: normalizeTaskRecovery(value.recovery),
  };
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  return value === "running"
    || value === "blocked"
    || value === "needs_user"
    || value === "failed"
    || value === "verified"
    || value === "completed"
    || value === "aborted"
    ? value
    : "pending";
}

function normalizeVerificationStatus(value: unknown): VerificationStatus | undefined {
  return value === "pending" || value === "passed" || value === "failed" || value === "ambiguous"
    ? value
    : undefined;
}

function normalizeVerificationStrategy(value: unknown): VerificationStrategy | undefined {
  return value === "deterministic" || value === "structural" || value === "llm"
    ? value
    : undefined;
}

function normalizeRecoveryAction(value: unknown): RecoveryAction | undefined {
  return value === "retry" || value === "replan" || value === "ask-user" || value === "stop"
    ? value
    : undefined;
}

function normalizeVerificationContract(value: unknown): VerificationContract | undefined {
  return value === "exit_code" || value === "artifact" || value === "assertion"
    ? value
    : undefined;
}

function normalizeTaskArtifact(value: unknown): TaskArtifact | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== "summary"
    && value.kind !== "file"
    && value.kind !== "path"
    && value.kind !== "output"
    && value.kind !== "verification"
  ) {
    return null;
  }

  if (typeof value.label !== "string" || typeof value.value !== "string") {
    return null;
  }

  return {
    kind: value.kind,
    label: value.label,
    value: value.value,
  };
}

function normalizeTaskOutput(value: unknown): TaskOutput | undefined {
  if (!isRecord(value)) return undefined;
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.map(normalizeTaskArtifact).filter((entry): entry is TaskArtifact => Boolean(entry))
    : undefined;

  return {
    summary: typeof value.summary === "string" ? value.summary : undefined,
    finalText: typeof value.finalText === "string" ? value.finalText : undefined,
    artifacts: artifacts && artifacts.length > 0 ? artifacts : undefined,
    verificationSummary: typeof value.verificationSummary === "string" ? value.verificationSummary : undefined,
  };
}

function normalizeVerificationHint(value: unknown): VerificationHint | undefined {
  if (!isRecord(value)) return undefined;
  const contract = normalizeVerificationContract(value.contract);
  if (!contract) return undefined;

  return {
    contract,
    expectedExitCode: typeof value.expectedExitCode === "number" ? value.expectedExitCode : undefined,
    artifactKind: value.artifactKind === "summary"
      || value.artifactKind === "file"
      || value.artifactKind === "path"
      || value.artifactKind === "output"
      || value.artifactKind === "verification"
      ? value.artifactKind
      : undefined,
    artifactLabel: typeof value.artifactLabel === "string" ? value.artifactLabel : undefined,
    assertionText: typeof value.assertionText === "string" ? value.assertionText : undefined,
    assertionPattern: typeof value.assertionPattern === "string" ? value.assertionPattern : undefined,
    assertionTarget: value.assertionTarget === "result" || value.assertionTarget === "summary" || value.assertionTarget === "finalText"
      ? value.assertionTarget
      : undefined,
  };
}

function normalizeTaskVerification(value: unknown): Task["verification"] {
  if (!isRecord(value)) return undefined;
  const status = normalizeVerificationStatus(value.status);
  const strategy = normalizeVerificationStrategy(value.strategy);
  if (!status || !strategy) return undefined;
  return {
    status,
    strategy,
    contract: normalizeVerificationContract(value.contract),
    summary: typeof value.summary === "string" ? value.summary : undefined,
  };
}

function normalizeTaskRecovery(value: unknown): Task["recovery"] {
  if (!isRecord(value)) return undefined;
  return {
    action: normalizeRecoveryAction(value.action),
    reason: typeof value.reason === "string" ? value.reason : undefined,
    retryCount: typeof value.retryCount === "number" ? value.retryCount : undefined,
    retryBudget: typeof value.retryBudget === "number" ? value.retryBudget : undefined,
    repeatCount: typeof value.repeatCount === "number" ? value.repeatCount : undefined,
    lastFailureReason: typeof value.lastFailureReason === "string" ? value.lastFailureReason : undefined,
    failureClass: value.failureClass === "failed" || value.failureClass === "blocked" || value.failureClass === "needs_user" || value.failureClass === "aborted"
      ? value.failureClass
      : undefined,
  };
}

function normalizePlanStep(value: unknown, fallbackId: string): PlanStepRecord | null {
  if (!isRecord(value)) return null;
  const task = normalizePlanTask(value.task, fallbackId);
  if (!task) return null;

  let evaluation: EvaluationResult | undefined;
  const evaluationValue = isRecord(value.evaluation) ? value.evaluation : undefined;
  if (
    evaluationValue
    && typeof evaluationValue.success === "boolean"
    && (evaluationValue.outcome === "success"
      || evaluationValue.outcome === "failure"
      || evaluationValue.outcome === "ambiguous")
  ) {
    evaluation = {
      success: evaluationValue.success,
      outcome: evaluationValue.outcome as EvaluationResult["outcome"],
      reason: typeof evaluationValue.reason === "string" ? evaluationValue.reason : undefined,
      strategy: normalizeVerificationStrategy(evaluationValue.strategy),
      contract: normalizeVerificationContract(evaluationValue.contract),
    };
  }

  return {
    task,
    result: value.result,
    output: normalizeTaskOutput(value.output),
    evaluation,
  };
}

function normalizeAutopilotDecisionKind(value: unknown): AutopilotDecisionKind | undefined {
  return value === "start"
    || value === "resume"
    || value === "continue-next-task"
    || value === "retry"
    || value === "replan"
    || value === "stop"
    ? value
    : undefined;
}

function normalizeAutopilotGuardKind(value: unknown): AutopilotGuardKind | undefined {
  return value === "repeated_failure"
    || value === "repeated_tail"
    || value === "no_progress"
    || value === "max_cycles"
    ? value
    : undefined;
}

function normalizeAutopilotDecision(value: unknown): AutopilotDecisionRecord | null {
  if (!isRecord(value)) return null;
  const kind = normalizeAutopilotDecisionKind(value.kind);
  if (!kind) return null;
  if (typeof value.cycle !== "number" || !Number.isFinite(value.cycle)) return null;
  if (typeof value.reason !== "string" || typeof value.createdAt !== "string") return null;

  return {
    cycle: value.cycle,
    kind,
    reason: value.reason,
    createdAt: value.createdAt,
    taskId: typeof value.taskId === "string" ? value.taskId : undefined,
    guardKind: normalizeAutopilotGuardKind(value.guardKind),
    progress: typeof value.progress === "string" ? value.progress : undefined,
  };
}

function normalizePlanRunRecord(value: Record<string, unknown>): PlanRunRecord | null {
  const planRunId = typeof value.planRunId === "string"
    ? value.planRunId
    : typeof value.id === "string"
      ? value.id
      : undefined;

  if (!planRunId || typeof value.sessionId !== "string" || typeof value.createdAt !== "string" || typeof value.goal !== "string") {
    return null;
  }

  if (!isRecord(value.plan) || typeof value.plan.goal !== "string" || !Array.isArray(value.plan.tasks)) {
    return null;
  }

  const {
    _type: _legacyType,
    planRunId: _legacyPlanRunId,
    id: _legacyId,
    sessionId: _legacySessionId,
    createdAt: _legacyCreatedAt,
    goal: _legacyGoal,
    plan: _legacyPlan,
    steps: _legacySteps,
    mode: _legacyMode,
    source: _legacySource,
    cwd: _legacyCwd,
    providerName: _legacyProviderName,
    model: _legacyModel,
    prompt: _legacyPrompt,
    activeTaskId: _legacyActiveTaskId,
    nextAction: _legacyNextAction,
    recoveryAction: _legacyRecoveryAction,
    resumeEligible: _legacyResumeEligible,
    summary: _legacySummary,
    completed: _legacyCompleted,
    status: _legacyStatus,
    resultText: _legacyResultText,
    error: _legacyError,
    ...rest
  } = value;

  const planTasks = (value.plan.tasks as unknown[])
    .map((task, index) => normalizePlanTask(task, `task-${index + 1}`))
    .filter((task): task is Task => Boolean(task));

  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps
    .map((step, index) => normalizePlanStep(step, `task-${index + 1}`))
    .filter((step): step is PlanStepRecord => Boolean(step));

  const summary = isRecord(value.summary) ? value.summary : undefined;

  return {
    _type: "plan_run",
    planRunId,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    mode: value.mode === "goal" || value.mode === "plan" || value.mode === "autopilot" ? value.mode : undefined,
    source: value.source === "cli" || value.source === "tui" ? value.source : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    providerName: typeof value.providerName === "string" ? value.providerName : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    prompt: typeof value.prompt === "string" ? value.prompt : undefined,
    goal: value.goal,
    activeTaskId: typeof value.activeTaskId === "string" ? value.activeTaskId : undefined,
    nextAction: typeof value.nextAction === "string" ? value.nextAction : undefined,
    recoveryAction: normalizeRecoveryAction(value.recoveryAction),
    resumeEligible: typeof value.resumeEligible === "boolean" ? value.resumeEligible : undefined,
    lastVerificationSummary: typeof value.lastVerificationSummary === "string" ? value.lastVerificationSummary : undefined,
    lastFailureClass: value.lastFailureClass === "failed"
      || value.lastFailureClass === "blocked"
      || value.lastFailureClass === "needs_user"
      || value.lastFailureClass === "aborted"
      ? value.lastFailureClass
      : undefined,
    lastFailureReason: typeof value.lastFailureReason === "string" ? value.lastFailureReason : undefined,
    lastRecoveryRationale: typeof value.lastRecoveryRationale === "string" ? value.lastRecoveryRationale : undefined,
    cycleCount: typeof value.cycleCount === "number" && Number.isFinite(value.cycleCount) ? value.cycleCount : undefined,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
    decisionLog: Array.isArray(value.decisionLog)
      ? value.decisionLog.map(normalizeAutopilotDecision).filter((entry): entry is AutopilotDecisionRecord => Boolean(entry))
      : undefined,
    plan: {
      goal: value.plan.goal,
      tasks: planTasks,
    },
    steps,
    summary: summary
      && typeof summary.completed === "number"
      && typeof summary.failed === "number"
      && typeof summary.ambiguous === "number"
      ? {
          completed: summary.completed,
          failed: summary.failed,
          ambiguous: summary.ambiguous,
          verified: typeof summary.verified === "number" ? summary.verified : undefined,
        }
      : undefined,
    completed: typeof value.completed === "boolean" ? value.completed : undefined,
    status: value.status === "running"
      || value.status === "completed"
      || value.status === "failed"
      || value.status === "aborted"
      || value.status === "blocked"
      || value.status === "needs_user"
      ? value.status
      : undefined,
    resultText: typeof value.resultText === "string" ? value.resultText : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    ...rest,
  };
}

export function createPlanRunRecord(
  record: Omit<PlanRunRecord, "_type" | "createdAt" | "planRunId"> & {
    planRunId?: string;
    id?: string;
    createdAt?: string;
  },
): PlanRunRecord {
  const planRunId = record.planRunId ?? record.id;
  if (!planRunId) {
    throw new Error("planRunId is required for plan run records");
  }

  const {
    id: _legacyId,
    planRunId: _legacyPlanRunId,
    createdAt,
    sessionId: rawSessionId,
    goal: rawGoal,
    plan: rawPlan,
    steps: rawSteps,
    ...rest
  } = record;

  const sessionId = rawSessionId as PlanRunRecord["sessionId"];
  const goal = rawGoal as PlanRunRecord["goal"];
  const plan = rawPlan as PlanRunRecord["plan"];
  const steps = rawSteps as PlanRunRecord["steps"];

  if (!sessionId) {
    throw new Error("sessionId is required for plan run records");
  }

  return {
    _type: "plan_run",
    planRunId,
    sessionId,
    createdAt: createdAt ?? new Date().toISOString(),
    goal,
    plan,
    steps,
    ...rest,
  } as PlanRunRecord;
}

export const createPlanExecutionRecord = createPlanRunRecord;

// ---------------------------------------------------------------------------
// Agent trace records
// ---------------------------------------------------------------------------

const AGENT_TRACE_EVENT_KINDS: readonly AgentTraceEventKind[] = [
  "tool_planned",
  "tool_executed",
  "tool_failed",
  "permission_allow",
  "permission_ask",
  "permission_deny",
  "hook_blocking",
  "hook_error",
  "evaluator_decision",
  "completion_decision",
  "recovery_checkpoint_created",
  "recovery_resumed",
  "verification_evidence",
];

function isAgentTraceEventKind(value: unknown): value is AgentTraceEventKind {
  return typeof value === "string" && (AGENT_TRACE_EVENT_KINDS as readonly string[]).includes(value);
}

function normalizeTraceMetadata(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function createAgentTraceRecord(
  record: Omit<AgentTraceRecord, "_type" | "timestamp" | "traceId"> & {
    traceId?: string;
    id?: string;
    timestamp?: string;
  },
): AgentTraceRecord {
  const traceId = record.traceId ?? record.id;
  if (!traceId) {
    throw new Error("traceId is required for agent trace records");
  }
  if (!record.sessionId) {
    throw new Error("sessionId is required for agent trace records");
  }

  const {
    id: _legacyId,
    traceId: _legacyTraceId,
    timestamp,
    sessionId,
    eventKind,
    reason,
    toolName,
    toolUseId,
    outcome,
    metadata,
    ...rest
  } = record;

  return {
    _type: "agent_trace",
    traceId,
    sessionId,
    timestamp: timestamp ?? new Date().toISOString(),
    eventKind,
    reason,
    toolName,
    toolUseId,
    outcome,
    metadata,
    ...rest,
  };
}

function normalizeAgentTraceRecord(value: Record<string, unknown>): AgentTraceRecord | null {
  const traceId = typeof value.traceId === "string"
    ? value.traceId
    : typeof value.id === "string"
      ? value.id
      : undefined;

  if (
    !traceId
    || typeof value.sessionId !== "string"
    || typeof value.timestamp !== "string"
    || !isAgentTraceEventKind(value.eventKind)
  ) {
    return null;
  }

  const {
    _type: _legacyType,
    traceId: _legacyTraceId,
    id: _legacyId,
    sessionId: _legacySessionId,
    timestamp: _legacyTimestamp,
    eventKind: _legacyEventKind,
    reason: _legacyReason,
    toolName: _legacyToolName,
    toolUseId: _legacyToolUseId,
    outcome: _legacyOutcome,
    metadata: _legacyMetadata,
    ...rest
  } = value;

  return {
    _type: "agent_trace",
    traceId,
    sessionId: value.sessionId,
    timestamp: value.timestamp,
    eventKind: value.eventKind,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    toolUseId: typeof value.toolUseId === "string" ? value.toolUseId : undefined,
    outcome: typeof value.outcome === "string" ? value.outcome : undefined,
    metadata: normalizeTraceMetadata(value.metadata),
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function normalizeSubAgentRunRecord(value: Record<string, unknown>): SubAgentRunRecord | null {
  const childId = typeof value.childId === "string"
    ? value.childId
    : typeof value.id === "string"
      ? value.id
      : undefined;

  if (!childId || typeof value.sessionId !== "string" || typeof value.createdAt !== "string") {
    return null;
  }

  const parsed: SubAgentRunRecord = {
    _type: "sub_agent_run",
    childId,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    parentToolUseId: typeof value.parentToolUseId === "string" ? value.parentToolUseId : undefined,
    parentMessageIndex: typeof value.parentMessageIndex === "number" ? value.parentMessageIndex : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    providerName: typeof value.providerName === "string" ? value.providerName : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    agentDepth: typeof value.agentDepth === "number" ? value.agentDepth : undefined,
    usedTools: Array.isArray(value.usedTools) ? value.usedTools.filter((tool): tool is string => typeof tool === "string") : undefined,
    prompt: typeof value.prompt === "string" ? value.prompt : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    finalText: typeof value.finalText === "string" ? value.finalText : undefined,
    turns: typeof value.turns === "number" ? value.turns : undefined,
    usage: isRecord(value.usage) && typeof value.usage.inputTokens === "number" && typeof value.usage.outputTokens === "number" && typeof value.usage.totalTokens === "number"
      ? {
          inputTokens: value.usage.inputTokens,
          outputTokens: value.usage.outputTokens,
          totalTokens: value.usage.totalTokens,
        }
      : undefined,
    success: typeof value.success === "boolean" ? value.success : undefined,
    status: value.status === "started" || value.status === "completed" || value.status === "error" || value.status === "aborted"
      ? value.status
      : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    transcript: Array.isArray(value.transcript) && value.transcript.every(isChatMessage)
      ? (value.transcript as ChatMessage[])
      : undefined,
    resultKind: value.resultKind === "single" || value.resultKind === "child" || value.resultKind === "coordinator"
      ? value.resultKind
      : undefined,
    childCount: typeof value.childCount === "number" ? value.childCount : undefined,
    completedCount: typeof value.completedCount === "number" ? value.completedCount : undefined,
    failedCount: typeof value.failedCount === "number" ? value.failedCount : undefined,
    partial: typeof value.partial === "boolean" ? value.partial : undefined,
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.map(normalizeSubAgentArtifact).filter((artifact): artifact is SubAgentArtifact => Boolean(artifact))
      : undefined,
    displayTitle: typeof value.displayTitle === "string" ? value.displayTitle : undefined,
    displaySummary: typeof value.displaySummary === "string" ? value.displaySummary : undefined,
  };

  return parsed;
}

function normalizeSubAgentArtifact(value: unknown): SubAgentArtifact | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = value.kind;
  if (
    (kind !== "summary" && kind !== "final_text" && kind !== "tools" && kind !== "status" && kind !== "failure")
    || typeof value.label !== "string"
    || typeof value.value !== "string"
  ) {
    return null;
  }

  return {
    kind,
    label: value.label,
    value: value.value,
  };
}

function formatSubAgentStatusLabel(record: Pick<SubAgentRunRecord, "resultKind" | "status" | "partial" | "childCount" | "completedCount" | "failedCount">): string {
  if (record.resultKind === "coordinator") {
    const childCount = record.childCount ?? 0;
    const completed = record.completedCount ?? 0;
    const failed = record.failedCount ?? 0;
    const prefix = record.partial ? "partial" : record.status ?? "completed";
    return `${prefix} • ${childCount} child${childCount === 1 ? "" : "ren"} (${completed} completed, ${failed} failed)`;
  }

  if (record.resultKind === "child") {
    return record.status ? `child • ${record.status}` : "child";
  }

  return record.status ?? "completed";
}

function buildSubAgentDisplayTitle(record: Pick<SubAgentRunRecord, "resultKind" | "childId" | "providerName" | "model" | "status" | "partial">): string {
  const modelSuffix = record.model ? ` @ ${record.model}` : "";
  const providerSuffix = record.providerName ? ` (${record.providerName}${modelSuffix})` : modelSuffix;

  if (record.resultKind === "coordinator") {
    return `coordinator${providerSuffix}`;
  }

  if (record.resultKind === "child") {
    return `${record.childId}${providerSuffix}`;
  }

  return `${record.childId}${providerSuffix}`;
}

function buildSubAgentDisplaySummary(record: SubAgentRunRecord): string {
  const base = record.summary?.trim() || record.finalText?.trim() || record.error?.trim() || "(no summary)";
  const artifactSummary = record.artifacts?.find((artifact) => artifact.kind === "summary" || artifact.kind === "status")?.value;
  const statusLabel = formatSubAgentStatusLabel(record);

  if (artifactSummary && artifactSummary.trim() !== base) {
    return `${statusLabel}: ${artifactSummary.trim()}`;
  }

  return `${statusLabel}: ${base}`;
}

export function formatSubAgentRunForDisplay(record: SubAgentRunRecord): SubAgentRunRecord {
  return {
    ...record,
    displayTitle: record.displayTitle ?? buildSubAgentDisplayTitle(record),
    displaySummary: record.displaySummary ?? buildSubAgentDisplaySummary(record),
  };
}

export function summarizeSubAgentRunRecord(record: SubAgentRunRecord): string {
  return formatSubAgentRunForDisplay(record).displaySummary ?? "(no summary)";
}

export function parseSessionLine(line: string): ParsedSessionLine {
  try {
    const parsed: unknown = JSON.parse(line);

    if (isSessionHeaderRecord(parsed)) {
      return { kind: "structured", record: parsed };
    }

    if (isRecord(parsed) && (parsed._type === "sub_agent_run" || parsed._type === "child_execution")) {
      const normalized = normalizeSubAgentRunRecord(parsed);
      if (normalized) {
        return { kind: "structured", record: normalized };
      }
    }

    if (isRecord(parsed) && parsed._type === "plan_run") {
      const normalized = normalizePlanRunRecord(parsed);
      if (normalized) {
        return { kind: "structured", record: normalized };
      }
    }

    if (isRecord(parsed) && parsed._type === "agent_trace") {
      const normalized = normalizeAgentTraceRecord(parsed);
      if (normalized) {
        return { kind: "structured", record: normalized };
      }
    }

    if (isTranscriptEntryRecord(parsed)) {
      return { kind: "structured", record: parsed };
    }

    if (isChatMessage(parsed)) {
      return { kind: "message", message: parsed };
    }
  } catch {
    // Fall through to unknown.
  }

  return { kind: "unknown" };
}
