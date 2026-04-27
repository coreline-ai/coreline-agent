/**
 * Incident Memory Layer types (Wave 8 Phase 6).
 *
 * Port of MemKraft incident.py — operational incidents as first-class
 * memory with bitemporal semantics, tier auto-assignment, and
 * evidence-backed structure.
 */

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "resolved";

export interface IncidentHypothesis {
  text: string;
  status: "testing" | "rejected" | "confirmed";
  notedAt: string;
}

export interface IncidentEvidence {
  type: string; // "stderr", "stdout", "log", "metric", etc.
  value: string;
  collectedAt: string;
}

export interface IncidentRecord {
  id: string; // "inc-{YYYYMMDD}-{HHMMSS}-{hash8}"
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detectedAt: string;
  resolvedAt?: string;
  validFrom: string;
  validTo?: string;
  recordedAt: string;
  tier: "core" | "recall" | "archival";
  source: string; // "tool_failure" | "manual" | "recovery"
  affected: string[];
  tags: string[];
  toolUseId?: string;
  turnIndex?: number;
  symptoms: string[];
  evidence: IncidentEvidence[];
  hypotheses: IncidentHypothesis[];
  resolution?: string;
  related: string[]; // free-form: "decision: dec-xxx", "incident: inc-yyy"
}

export interface IncidentRecordOptions {
  evidence?: IncidentEvidence[];
  hypothesis?: string[];
  resolution?: string;
  severity?: IncidentSeverity;
  affected?: string[];
  detectedAt?: string;
  source?: string;
  tags?: string[];
  tier?: "core" | "recall" | "archival";
  toolUseId?: string;
  turnIndex?: number;
}

export interface IncidentUpdate {
  addSymptoms?: string[];
  addEvidence?: IncidentEvidence[];
  addHypothesis?: string[];
  rejectHypothesis?: string[];
  confirmHypothesis?: string[];
  resolution?: string;
  resolved?: boolean;
  severity?: IncidentSeverity;
  tags?: string[];
  affected?: string[];
  related?: string[]; // append to ## Related section
}

export interface IncidentSearchOptions {
  query?: string;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
  resolved?: boolean;
  affected?: string;
  timeframe?: [string, string]; // [startIso, endIso]
  limit?: number;
}
