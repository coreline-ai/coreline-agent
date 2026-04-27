/**
 * Related-incident finder (Wave 9 Phase 9) — port of MemKraft rca.py:158-197.
 *
 * Discovers incidents similar to a given one via blended scoring of:
 * - max symptom-pair similarity (Ratcliff-Obershelp fuzzy)
 * - Jaccard-ish affected-component overlap.
 *
 * Self-recursion guard: this module ONLY calls `incidentSearch` (which never
 * triggers RCA) and excludes the input incident id, so no nested RCA can occur.
 */

import { similarityScoreFuzzy } from "../../memory/similarity.js";
import { incidentSearch } from "../incident/incident-store.js";
import type { IncidentRecord } from "../incident/types.js";
import type { RelatedIncidentMatch } from "./types.js";

const MIN_SIMILARITY = 0.2;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function maxSymptomSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  for (const sa of a) {
    for (const sb of b) {
      const sim = similarityScoreFuzzy(sa, sb);
      if (sim > best) best = sim;
    }
  }
  return best;
}

function affectedJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const x of setA) {
    if (setB.has(x)) intersect += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  if (union === 0) return 0;
  return intersect / union;
}

/**
 * Find incidents most similar to `incident` for a given project.
 * Excludes the input incident itself. Returns up to `maxRelated` matches
 * with similarity > 0.2, sorted desc.
 */
export function findRelatedIncidents(
  projectId: string,
  incident: IncidentRecord,
  maxRelated: number,
  rootDir?: string,
): RelatedIncidentMatch[] {
  const candidates = incidentSearch(projectId, { limit: 100 }, rootDir);
  const matches: RelatedIncidentMatch[] = [];

  for (const other of candidates) {
    if (other.id === incident.id) continue;
    const symptomSim = maxSymptomSimilarity(incident.symptoms, other.symptoms);
    const affectedSim = affectedJaccard(incident.affected, other.affected);
    const similarity = 0.7 * symptomSim + 0.3 * affectedSim;
    if (similarity <= MIN_SIMILARITY) continue;
    matches.push({
      incidentId: other.id,
      title: other.title,
      severity: other.severity,
      status: other.status,
      similarity: round4(similarity),
      detectedAt: other.detectedAt,
    });
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  if (maxRelated > 0 && matches.length > maxRelated) {
    return matches.slice(0, maxRelated);
  }
  return matches;
}
