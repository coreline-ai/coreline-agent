/**
 * Subagent performance tracker — records evidence for Agent tool dispatches.
 * Called from persistSubAgentRuns / persistChildResult in agent-tool.ts.
 * Best-effort: write failures are returned but never thrown.
 */

import type { EvidenceAppendResult, EvidenceOutcome, EvidenceRecord } from "./types.js";
import { appendEvidence, readEvidence } from "./evidence.js";

export interface SubagentRunRecord {
  subagentType: string;
  parentSessionId: string;
  agentDepth: number;
  outcome: EvidenceOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Record a single subagent run. Iteration is auto-computed from existing
 * evidence for (subagent, subagentType). Best-effort — returns
 * {recorded:false,error} on failure rather than throwing.
 */
export function recordSubagentRun(
  projectId: string,
  record: SubagentRunRecord,
  rootDir?: string,
): EvidenceAppendResult {
  if (!projectId) return { recorded: false, error: "projectId is required" };
  if (!record.subagentType) {
    return { recorded: false, error: "subagentType is required" };
  }

  const existing = readEvidence(projectId, "subagent", record.subagentType, {}, rootDir);
  const iteration = existing.length + 1;

  const metadata: Record<string, unknown> = {
    ...(record.metadata ?? {}),
    agentDepth: record.agentDepth,
  };

  const evidence: EvidenceRecord = {
    domain: "subagent",
    id: record.subagentType,
    sessionId: record.parentSessionId,
    iteration,
    invokedAt: new Date().toISOString(),
    outcome: record.outcome,
    metadata,
  };

  return appendEvidence(projectId, evidence, rootDir);
}

/**
 * Heuristic to extract a subagent "type" from a delegation prompt.
 *
 * - If the prompt starts with `[Name]`, return `Name`.
 * - Else, take the first 40 characters of the trimmed prompt (whitespace collapsed).
 * - Else, return `"unspecified"`.
 */
export function extractSubagentType(prompt: string): string {
  if (!prompt) return "unspecified";
  const trimmed = prompt.trim();
  if (!trimmed) return "unspecified";

  const match = trimmed.match(/^\[([A-Za-z][A-Za-z0-9-]*)\]/);
  if (match && match[1]) {
    return match[1];
  }

  const collapsed = trimmed.replace(/\s+/g, " ");
  const prefix = collapsed.slice(0, 40).trim();
  return prefix || "unspecified";
}
