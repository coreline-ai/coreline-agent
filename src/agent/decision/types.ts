/**
 * Decision Layer types (Wave 9 Phase 7) — port of MemKraft decision_store.py.
 *
 * Records product/architectural/operational decisions as first-class memory
 * with bitemporal semantics and optional bidirectional linking to incidents.
 * Captures What/Why/How per YongKeun Park's principle.
 */

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

export interface DecisionRecord {
  id: string; // "dec-{YYYYMMDD}-{slug}"
  title: string; // = what (one-line)
  status: DecisionStatus;
  decidedAt: string;
  validFrom: string;
  validTo?: string;
  recordedAt: string;
  tier: "core" | "recall" | "archival";
  source: string; // "manual" | "auto-convergence" | "rca"
  tags: string[];
  linkedIncidents: string[];
  what: string;
  why: string;
  how: string;
  outcome?: string;
}

export interface DecisionRecordOptions {
  outcome?: string;
  tags?: string[];
  linkedIncidents?: string[];
  status?: DecisionStatus;
  decidedAt?: string;
  source?: string;
  tier?: "core" | "recall" | "archival";
  validFrom?: string;
  validTo?: string;
}

export interface DecisionUpdate {
  outcome?: string;
  appendWhy?: string;
  appendHow?: string;
  status?: DecisionStatus;
  tags?: string[];
  linkedIncidents?: string[];
}

export interface DecisionSearchOptions {
  query?: string;
  status?: DecisionStatus;
  tag?: string;
  linkedIncident?: string;
  timeframe?: [string, string];
  limit?: number;
}

export interface EvidenceFirstResult {
  query: string;
  elapsedMs: number;
  counts: { memory: number; incident: number; decision: number };
  results: Array<
    | { _source: "memory"; sessionId?: string; summary: string; score: number; ageDays?: number }
    | { _source: "incident"; id: string; title: string; severity: string; status: string; score: number }
    | { _source: "decision"; id: string; title: string; status: string; source: string; score: number }
  >;
}
