/**
 * Plan-execute convergence gate — wraps onTaskEnd to check for convergence
 * and signal stop when recent iterations stabilised.
 *
 * Wiring into executePlan's onTaskEnd callback is deferred to a later
 * integration phase (Phase 14). For now this exposes a ready-to-wire utility:
 * call `recordIterationAndCheck` from your caller's onTaskEnd (or after each
 * iteration) and honour `result.stop` to break the loop.
 */

import type { PlanExecutionStep } from "./types.js";
import type {
  ConvergenceVerdict,
  EvidenceOutcome,
  EvidenceRecord,
} from "../self-improve/types.js";
import { appendEvidence, readEvidence } from "../self-improve/evidence.js";
import { checkConvergence } from "../self-improve/convergence.js";
import { decisionRecord } from "../decision/decision-store.js";

export interface ConvergenceGateOptions {
  projectId: string;
  sessionId: string;
  /** Stable plan id for grouping evidence. Caller responsibility. */
  planId: string;
  /** Env-var override; defaults to CORELINE_DISABLE_CONVERGENCE_AUTOSTOP !== "1". */
  enabled?: boolean;
  /** Optional override for evidence root dir (mostly for tests). */
  rootDir?: string;
  /** Optional override for current timestamp (mostly for tests). */
  now?: () => Date;
}

export interface ConvergenceGateResult {
  stop: boolean;
  verdict: ConvergenceVerdict;
}

function isAutostopDisabled(): boolean {
  return process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP === "1";
}

function buildOutcome(step: PlanExecutionStep): EvidenceOutcome {
  return {
    success: step.evaluation?.success ?? false,
    // PlanExecutionStep doesn't expose these directly; leave undefined.
    turnsUsed: undefined,
    toolCalls: undefined,
    durationMs: undefined,
    unclearPoints: [],
  };
}

/**
 * Record this iteration's outcome and check if we should stop.
 * Iteration number is auto-computed from existing evidence for (plan-iteration, planId).
 */
export function recordIterationAndCheck(
  options: ConvergenceGateOptions,
  step: PlanExecutionStep,
): ConvergenceGateResult {
  const { projectId, sessionId, planId, rootDir } = options;
  const enabled = options.enabled ?? !isAutostopDisabled();
  const now = options.now ? options.now() : new Date();

  // Compute iteration from existing evidence.
  const existing = readEvidence(projectId, "plan-iteration", planId, {}, rootDir);
  const iteration = existing.length + 1;

  const record: EvidenceRecord = {
    domain: "plan-iteration",
    id: planId,
    sessionId,
    iteration,
    invokedAt: now.toISOString(),
    outcome: buildOutcome(step),
  };

  appendEvidence(projectId, record, rootDir);

  // Read full history (including the record we just appended) and check.
  const all = readEvidence(projectId, "plan-iteration", planId, {}, rootDir);
  const verdict = checkConvergence({ records: all });

  // C2 / D10 — auto-record decision on successful convergence (best-effort).
  if (verdict.converged === true && process.env.AUTO_RECORD_DECISIONS !== "false") {
    try {
      if (projectId) {
        const what = `Auto-record: plan ${planId} converged`;
        const why = `Plan-execute converged after ${verdict.iterationsChecked.length} iterations: ${verdict.reason}`;
        const how = `Metrics: ${JSON.stringify(verdict.metrics)}`;
        decisionRecord(
          projectId,
          what,
          why,
          how,
          {
            source: "auto-convergence",
            tags: ["plan-execute", "auto-record"],
            linkedIncidents: [],
          },
          rootDir,
        );
      }
    } catch {
      // best-effort
    }
  }

  if (!enabled) {
    return { stop: false, verdict };
  }

  return { stop: verdict.converged, verdict };
}
