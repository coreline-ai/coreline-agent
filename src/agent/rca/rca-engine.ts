/**
 * RCA Engine — Wave 9 heuristic baseline + Wave 10 P2 / F6 opt-in LLM strategy.
 *
 * Computes a structured RCA report (scored hypotheses + suggested runbooks
 * probed via the first symptom with `touch:false` + related incidents).
 * `strategy: "llm"` activates the Anthropic-backed scorer when
 * `RCA_LLM_ENABLED=true` AND `ANTHROPIC_API_KEY` is set; any failure falls
 * back to the deterministic heuristic.
 */

import { incidentGet } from "../incident/incident-store.js";
import { runbookMatch } from "../runbook/runbook-store.js";
import { scoreAllHypotheses } from "./hypothesis-scorer.js";
import { scoreHypothesesViaLLM } from "./llm-strategy.js";
import { findRelatedIncidents } from "./related-incidents.js";
import type { RCAOptions, RCAReport, ScoredHypothesis } from "./types.js";

/**
 * Compute an RCA report for the given incident.
 * Throws if the incident does not exist or the strategy is unsupported.
 *
 * For `strategy: "llm"`, the LLM scorer is best-effort: any failure
 * (env var off, API key missing, network error, parse failure, timeout)
 * results in a transparent fallback to the heuristic and a console.warn.
 * The returned report's `strategy` field reflects what actually executed.
 */
export async function computeRCA(
  projectId: string,
  incidentId: string,
  options?: RCAOptions,
  rootDir?: string,
): Promise<RCAReport> {
  const requestedStrategy = options?.strategy ?? "heuristic";
  if (requestedStrategy !== "heuristic" && requestedStrategy !== "llm") {
    throw new Error(`Unknown RCA strategy: ${String(requestedStrategy)}`);
  }

  const incident = incidentGet(projectId, incidentId, rootDir);
  if (!incident) {
    throw new Error(`Incident not found: ${incidentId}`);
  }

  const includeRelated = options?.includeRelated !== false;
  const maxRelated = options?.maxRelated ?? 3;
  const maxRunbooks = options?.maxRunbooks ?? 3;

  let hypotheses: ScoredHypothesis[];
  let effectiveStrategy: "heuristic" | "llm" = "heuristic";

  if (requestedStrategy === "llm") {
    const llmResult = await scoreHypothesesViaLLM(incident);
    if (llmResult.used) {
      hypotheses = [
        ...llmResult.hypotheses,
        ...(llmResult.newHypotheses ?? []),
      ];
      effectiveStrategy = "llm";
    } else {
      console.warn(
        `[rca] LLM strategy fallback to heuristic: ${llmResult.fallbackReason ?? "unknown"}`,
      );
      hypotheses = scoreAllHypotheses(incident);
    }
  } else {
    hypotheses = scoreAllHypotheses(incident);
  }

  // Suggested runbooks: probe with the first symptom (or "" if none).
  // touch:false — RCA is pure observation, must not mutate runbook stats.
  const probe = incident.symptoms[0] ?? "";
  const suggestedRunbooks = probe
    ? runbookMatch(projectId, probe, { limit: maxRunbooks, touch: false }, rootDir)
    : [];

  const relatedIncidents = includeRelated
    ? findRelatedIncidents(projectId, incident, maxRelated, rootDir)
    : [];

  return {
    incidentId: incident.id,
    strategy: effectiveStrategy,
    severity: incident.severity,
    status: incident.status,
    hypotheses,
    suggestedRunbooks,
    relatedIncidents,
    evidenceCount: incident.evidence.length,
    symptomCount: incident.symptoms.length,
  };
}
