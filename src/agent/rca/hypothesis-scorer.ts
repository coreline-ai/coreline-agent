/**
 * Heuristic hypothesis scorer (Wave 9 Phase 9) — port of MemKraft rca.py:97-122.
 *
 * Deterministic scoring rules:
 * - confirmed → 0.95
 * - rejected  → 0.05
 * - testing   → max(0.3, symptomSimilarity) + evidenceBonus, capped at 0.9
 *   where evidenceBonus = min(0.25, 0.05 * evidenceCount).
 *
 * symptomSimilarity = max similarity (Ratcliff-Obershelp fuzzy) between the
 * hypothesis text and any symptom on the incident.
 */

import { similarityScoreFuzzy } from "../../memory/similarity.js";
import type { IncidentHypothesis, IncidentRecord } from "../incident/types.js";
import type { ScoredHypothesis } from "./types.js";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Score a single hypothesis heuristically.
 */
export function scoreHypothesis(
  hypothesis: IncidentHypothesis,
  incident: IncidentRecord,
  evidenceCount: number,
): ScoredHypothesis {
  const status = hypothesis.status;
  let score: number;

  if (status === "confirmed") {
    score = 0.95;
  } else if (status === "rejected") {
    score = 0.05;
  } else {
    // testing
    let baseSim = 0;
    for (const symptom of incident.symptoms) {
      const sim = similarityScoreFuzzy(hypothesis.text, symptom);
      if (sim > baseSim) baseSim = sim;
    }
    const evidenceBonus = Math.min(0.25, 0.05 * evidenceCount);
    score = Math.min(0.9, Math.max(0.3, baseSim) + evidenceBonus);
  }

  return {
    text: hypothesis.text,
    status,
    score: round4(score),
  };
}

/**
 * Score every hypothesis on an incident; returned list is sorted desc by score.
 */
export function scoreAllHypotheses(incident: IncidentRecord): ScoredHypothesis[] {
  const evidenceCount = incident.evidence.length;
  const scored = incident.hypotheses.map((h) => scoreHypothesis(h, incident, evidenceCount));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
