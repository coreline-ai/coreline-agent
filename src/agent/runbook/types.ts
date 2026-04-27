/**
 * Runbook Memory types (Wave 9 Phase 8).
 *
 * Port of MemKraft runbook.py — symptom→steps remediation patterns matched
 * against new symptoms via Ratcliff-Obershelp similarity + regex detection,
 * stored as MD frontmatter docs under `<projectMemory>/runbooks/`.
 */

export interface RunbookRecord {
  id: string; // "rb-{hash8}"
  type: "runbook";
  pattern: string; // searchable symptom pattern
  confidence: number; // [0, 1]
  usageCount: number;
  sourceIncidents: string[];
  createdAt: string;
  updatedAt: string;
  lastMatched?: string;
  tier: "core" | "recall" | "archival";
  tags: string[];
  symptom: string; // = pattern (for body section, MemKraft compat)
  cause?: string;
  steps: string[];
  evidenceCmd?: string;
  fixAction?: string;
  verification?: string;
}

export interface RunbookAddOptions {
  sourceIncidentId?: string;
  sourceIncidents?: string[];
  cause?: string;
  evidenceCmd?: string;
  fixAction?: string;
  verification?: string;
  confidence?: number; // default 0.5
  tags?: string[];
}

export interface RunbookMatch {
  runbook: RunbookRecord;
  similarity: number; // 0..1 (regex hit = 1.0)
  score: number; // 0.6 * similarity + 0.4 * confidence
  isRegexMatch: boolean;
}

export interface RunbookMatchOptions {
  minConfidence?: number; // default 0.0
  minScore?: number; // default 0.2
  limit?: number; // default 5
  touch?: boolean; // bump usageCount + confidence + lastMatched, default true
}

export interface RunbookApplyOptions {
  dryRun?: boolean; // default true (MVP)
}

export interface RunbookStepResult {
  step: string;
  status:
    | "simulated"
    | "manual_needed"
    | "success"
    | "error"
    | "permission_denied";
  output?: string;
}

export interface RunbookApplyResult {
  runbookId: string;
  success: boolean;
  stepsExecuted: number;
  stepResults: RunbookStepResult[];
  verificationPassed?: boolean;
  dryRun: boolean;
}
