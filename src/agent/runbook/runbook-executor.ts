/**
 * Runbook Executor (Wave 9 Phase 8 + Wave 10 P2 — F5).
 *
 * Loads a runbook by id and produces a structured `RunbookApplyResult`
 * describing per-step outcomes.
 *
 * Modes:
 *   - `dryRun: true` (default) — every step recorded as `simulated`.
 *   - `dryRun: false`:
 *       * default               — every step recorded as `manual_needed`
 *                                  (existing Wave 9 D12 MVP behaviour).
 *       * `RUNBOOK_SANDBOX_ENABLE=true` — each bash step is gated through
 *         `checkRunbookStepPermission` and, if allowed, executed via
 *         `Bun.spawn(["sh", "-c", step])` with a 5s wall-clock timeout.
 *         The first failing or denied step short-circuits the rest.
 *
 * Real execution stays opt-in. The public API of `runbookApply` is
 * unchanged except that it now returns a Promise.
 */

import { runbookGet } from "./runbook-store.js";
import { executeStepSandboxed } from "./sandbox-executor.js";
import type {
  RunbookApplyOptions,
  RunbookApplyResult,
  RunbookStepResult,
} from "./types.js";

const MANUAL_NEEDED_NOTE =
  "Real execution requires Wave 10+ sandboxed runtime — set RUNBOOK_SANDBOX_ENABLE=true";

function sandboxEnabled(): boolean {
  return process.env.RUNBOOK_SANDBOX_ENABLE === "true";
}

/**
 * Apply a runbook. Defaults to `dryRun: true`. Throws if the runbook is
 * not found.
 */
export async function runbookApply(
  projectId: string,
  runbookId: string,
  options?: RunbookApplyOptions,
  rootDir?: string,
): Promise<RunbookApplyResult> {
  const rb = runbookGet(projectId, runbookId, rootDir);
  if (!rb) {
    throw new Error(`runbook not found: ${runbookId}`);
  }

  const dryRun = options?.dryRun !== false; // default true
  const sandbox = !dryRun && sandboxEnabled();

  const stepResults: RunbookStepResult[] = [];
  let aborted = false;

  for (const step of rb.steps) {
    if (dryRun) {
      stepResults.push({ step, status: "simulated" });
      continue;
    }

    if (aborted) {
      // A previous step failed in sandbox mode — record nothing further;
      // we deliberately stop early to avoid compounding side effects.
      break;
    }

    if (sandbox) {
      const result = await executeStepSandboxed(step);
      stepResults.push(result);
      if (result.status === "error" || result.status === "permission_denied") {
        aborted = true;
      }
    } else {
      stepResults.push({
        step,
        status: "manual_needed",
        output: MANUAL_NEEDED_NOTE,
      });
    }
  }

  let verificationPassed: boolean | undefined;
  if (rb.verification) {
    if (dryRun) {
      stepResults.push({
        step: rb.verification,
        status: "simulated",
        output: "verification",
      });
      verificationPassed = true;
    } else if (sandbox && !aborted) {
      const result = await executeStepSandboxed(rb.verification);
      stepResults.push(result);
      verificationPassed = result.status === "success";
    } else if (sandbox && aborted) {
      // Skip verification: prior step already failed.
      verificationPassed = false;
    } else {
      stepResults.push({
        step: rb.verification,
        status: "manual_needed",
        output: MANUAL_NEEDED_NOTE,
      });
      verificationPassed = undefined;
    }
  }

  const success = stepResults.every((r) => r.status !== "error" && r.status !== "permission_denied");
  const stepsExecuted = stepResults.filter(
    (r) => r.status === "simulated" || r.status === "success",
  ).length;

  return {
    runbookId,
    success,
    stepsExecuted,
    stepResults,
    verificationPassed,
    dryRun,
  };
}
