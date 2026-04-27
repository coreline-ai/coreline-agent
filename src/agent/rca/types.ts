/**
 * RCA Engine types (Wave 9 Phase 9) — port of MemKraft rca.py.
 *
 * Structures for heuristic root-cause analysis: scored hypotheses,
 * related-incident matches, and the assembled RCA report.
 */

import type { IncidentSeverity, IncidentStatus } from "../incident/types.js";
import type { RunbookMatch } from "../runbook/types.js";

export interface ScoredHypothesis {
  text: string;
  status: "testing" | "rejected" | "confirmed";
  score: number; // 0..1, deterministic heuristic
}

export interface RelatedIncidentMatch {
  incidentId: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  similarity: number;
  detectedAt: string;
}

export interface RCAReport {
  incidentId: string;
  strategy: "heuristic" | "llm";
  severity: IncidentSeverity;
  status: IncidentStatus;
  hypotheses: ScoredHypothesis[];
  suggestedRunbooks: RunbookMatch[];
  relatedIncidents: RelatedIncidentMatch[];
  evidenceCount: number;
  symptomCount: number;
}

export interface RCAOptions {
  strategy?: "heuristic" | "llm"; // default "heuristic"
  includeRelated?: boolean; // default true
  maxRelated?: number; // default 3
  maxRunbooks?: number; // default 3
}
