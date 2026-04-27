import type { PlanRunMode, PlanRunRecord, PlanRunStatus } from "../session/records.js";
import type { ParallelAgentScheduler } from "./parallel/scheduler.js";
import type { ParallelAgentTaskRecord } from "./parallel/types.js";
import {
  createForkVerifierTaskWork,
  detectVerificationCommands,
  type VerificationCommand,
  type VerificationRequest,
} from "./fork-verifier.js";

export type AutoVerifierTrigger = Extract<PlanRunMode, "plan" | "goal" | "autopilot">;

export type AutoVerifierSkipReason =
  | "disabled"
  | "missing_scheduler"
  | "non_success_status"
  | "no_commands"
  | "unsupported_trigger";

export interface AutoVerifierPlanRunLike {
  planRunId?: string;
  mode?: PlanRunMode;
  status?: PlanRunStatus;
  completed?: boolean;
  goal?: string;
}

export interface AutoVerifierOptions {
  /** Default is false. Auto verification must be explicitly enabled by the caller. */
  enabled?: boolean;
  cwd: string;
  provider: string;
  model?: string;
  scheduler?: ParallelAgentScheduler;
  planRun?: AutoVerifierPlanRunLike | PlanRunRecord;
  trigger?: AutoVerifierTrigger;
  commands?: VerificationRequest["commands"];
  timeoutMs?: number;
  failFast?: boolean;
}

export interface AutoVerifierDecision {
  shouldRun: boolean;
  reason?: AutoVerifierSkipReason;
  trigger: AutoVerifierTrigger;
  status?: PlanRunStatus;
  completed?: boolean;
}

export interface AutoVerifierSubmitResult {
  started: boolean;
  taskId?: string;
  task?: ParallelAgentTaskRecord;
  reason?: AutoVerifierSkipReason;
  commands: VerificationCommand[];
}

const SUCCESS_STATUSES = new Set<PlanRunStatus>(["completed"]);
const NON_SUCCESS_STATUSES = new Set<PlanRunStatus>(["failed", "blocked", "needs_user", "aborted", "running"]);
const SUPPORTED_TRIGGERS = new Set<AutoVerifierTrigger>(["plan", "goal", "autopilot"]);

function normalizeTrigger(options: Pick<AutoVerifierOptions, "trigger" | "planRun">): AutoVerifierTrigger {
  const candidate = options.trigger ?? options.planRun?.mode ?? "plan";
  return candidate === "goal" || candidate === "autopilot" ? candidate : "plan";
}

function isSuccessStatus(status: PlanRunStatus | undefined, completed: boolean | undefined): boolean {
  if (status && NON_SUCCESS_STATUSES.has(status)) {
    return false;
  }
  if (status && SUCCESS_STATUSES.has(status)) {
    return true;
  }
  return completed === true;
}

export function shouldAutoRunVerifier(options: AutoVerifierOptions): AutoVerifierDecision {
  const trigger = normalizeTrigger(options);
  const status = options.planRun?.status;
  const completed = options.planRun?.completed;

  if (options.enabled !== true) {
    return { shouldRun: false, reason: "disabled", trigger, status, completed };
  }

  if (!SUPPORTED_TRIGGERS.has(trigger)) {
    return { shouldRun: false, reason: "unsupported_trigger", trigger, status, completed };
  }

  if (!options.scheduler) {
    return { shouldRun: false, reason: "missing_scheduler", trigger, status, completed };
  }

  if (!isSuccessStatus(status, completed)) {
    return { shouldRun: false, reason: "non_success_status", trigger, status, completed };
  }

  return { shouldRun: true, trigger, status, completed };
}

function commandsForRequest(options: AutoVerifierOptions): VerificationCommand[] {
  if (options.commands?.length) {
    return options.commands.map((command, index) => {
      if (typeof command === "string") {
        return { name: `command-${index + 1}`, command, source: "explicit" as const };
      }
      return command;
    });
  }
  return detectVerificationCommands(options.cwd);
}

function describeAutoVerifierTask(options: AutoVerifierOptions, trigger: AutoVerifierTrigger, commands: VerificationCommand[]): string {
  const prefix = `auto-verification:${trigger}`;
  const runId = options.planRun?.planRunId ? ` ${options.planRun.planRunId}` : "";
  const commandNames = commands.map((command) => command.name).join("/");
  return `${prefix}${runId} ${commandNames}`.trim();
}

export function startAutoVerifier(options: AutoVerifierOptions): AutoVerifierSubmitResult {
  const decision = shouldAutoRunVerifier(options);
  if (!decision.shouldRun) {
    return { started: false, reason: decision.reason, commands: [] };
  }

  const scheduler = options.scheduler;
  if (!scheduler) {
    return { started: false, reason: "missing_scheduler", commands: [] };
  }

  const commands = commandsForRequest(options);
  if (commands.length === 0) {
    return { started: false, reason: "no_commands", commands };
  }

  const trigger = decision.trigger;
  const { task, completion } = scheduler.submitTask(
    {
      prompt: `Run automatic verification for ${trigger}${options.planRun?.goal ? `: ${options.planRun.goal}` : ""}`,
      description: describeAutoVerifierTask(options, trigger, commands),
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      agentDepth: 0,
      write: false,
    },
    createForkVerifierTaskWork({
      cwd: options.cwd,
      commands,
      timeoutMs: options.timeoutMs,
      failFast: options.failFast ?? true,
    }),
  );
  completion.catch(() => undefined);
  return { started: true, taskId: task.id, task, commands };
}
