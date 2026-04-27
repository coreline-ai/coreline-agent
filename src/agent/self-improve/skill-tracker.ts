/**
 * Skill Performance Tracker — records evidence about built-in skill outcomes.
 *
 * Because built-in skills have no runtime hook, skill-tracker consumes the
 * applied-skill-registry at session end and writes one evidence record per
 * active skill. All I/O is best-effort and never throws.
 */

import type { EvidenceAppendResult, EvidenceOutcome, EvidenceRecord } from "./types.js";
import { appendEvidence, readEvidence } from "./evidence.js";
import { consumeAppliedSkills } from "./applied-skill-registry.js";

export interface SkillRunRecord {
  skillId: string;
  sessionId: string;
  outcome: EvidenceOutcome;
  metadata?: Record<string, unknown>;
}

/** Record a single skill-run. Computes iteration = 1 + existing record count. */
export function recordSkillRun(
  projectId: string,
  record: SkillRunRecord,
  rootDir?: string,
): EvidenceAppendResult {
  if (!projectId) return { recorded: false, error: "projectId is required" };
  if (!record.skillId) return { recorded: false, error: "skillId is required" };

  const existing = readEvidence(projectId, "skill", record.skillId, {}, rootDir);
  const iteration = existing.length + 1;

  const evidence: EvidenceRecord = {
    domain: "skill",
    id: record.skillId,
    sessionId: record.sessionId,
    iteration,
    invokedAt: new Date().toISOString(),
    outcome: record.outcome,
    metadata: record.metadata,
  };

  return appendEvidence(projectId, evidence, rootDir);
}

export interface SessionSkillEvalInput {
  projectId: string;
  sessionId: string;
  turnReason: "completed" | "aborted" | "error";
  turnsUsed?: number;
  toolCalls?: number;
  durationMs?: number;
  rootDir?: string;
}

/**
 * Consume active skills for session → record evidence for each.
 * Evaluation heuristic (PoC): success = (turnReason === "completed").
 * Best-effort — failures are swallowed.
 */
export function evaluateSessionSkills(input: SessionSkillEvalInput): void {
  if (!input.projectId || !input.sessionId) return;

  let selections: ReturnType<typeof consumeAppliedSkills>;
  try {
    selections = consumeAppliedSkills(input.sessionId);
  } catch {
    return;
  }
  if (selections.length === 0) return;

  const success = input.turnReason === "completed";
  const outcomeBase: EvidenceOutcome = {
    success,
    turnsUsed: input.turnsUsed,
    toolCalls: input.toolCalls,
    durationMs: input.durationMs,
  };

  for (const selection of selections) {
    try {
      recordSkillRun(
        input.projectId,
        {
          skillId: selection.skill.id,
          sessionId: input.sessionId,
          outcome: outcomeBase,
          metadata: {
            source: selection.source,
            reasonCode: selection.reasonCode,
            priority: selection.priority,
            turnReason: input.turnReason,
          },
        },
        input.rootDir,
      );
    } catch {
      // Best-effort — swallow per-skill write errors.
    }
  }
}
