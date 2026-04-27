/**
 * Incident escalation (Wave 8 Phase 6 / C3) — bridge from tool failures
 * to first-class incidents.
 *
 * Tracks per-session, per-tool failure counts. When a tool exceeds the
 * configured threshold, escalates to `incidentRecord(...)` with severity
 * resolved from the `INCIDENT_SEVERITY_MAP` env var (D15).
 *
 * Best-effort: every public function swallows internal errors so the
 * agent loop is never disrupted by incident telemetry.
 */

import { incidentRecord } from "./incident-store.js";
import { narrowSeverity } from "./severity-utils.js";
import type { IncidentEvidence, IncidentSeverity } from "./types.js";
import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_ESCALATION_THRESHOLD,
} from "../../memory/constants.js";

interface FailureEntry {
  toolName: string;
  errors: string[];
  firstAt: string;
  count: number;
}

/** outer key: sessionId, inner key: toolName */
const failureCounters = new Map<string, Map<string, FailureEntry>>();

function getSessionMap(sessionId: string, create: boolean): Map<string, FailureEntry> | undefined {
  let inner = failureCounters.get(sessionId);
  if (!inner && create) {
    inner = new Map();
    failureCounters.set(sessionId, inner);
  }
  return inner;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Counter API
// ---------------------------------------------------------------------------

/** Record one tool failure. Returns the new count for this tool in this session. */
export function recordToolFailure(sessionId: string, toolName: string, error: string): number {
  if (!sessionId || !toolName) return 0;
  const inner = getSessionMap(sessionId, true)!;
  let entry = inner.get(toolName);
  if (!entry) {
    entry = { toolName, errors: [], firstAt: nowIso(), count: 0 };
    inner.set(toolName, entry);
  }
  entry.count += 1;
  // Cap stored errors at 10 to bound memory.
  if (entry.errors.length < 10) {
    entry.errors.push(error);
  } else {
    entry.errors.shift();
    entry.errors.push(error);
  }
  return entry.count;
}

/** Reset a single tool counter (e.g., on success). */
export function resetToolFailure(sessionId: string, toolName: string): void {
  if (!sessionId || !toolName) return;
  const inner = getSessionMap(sessionId, false);
  if (!inner) return;
  inner.delete(toolName);
  if (inner.size === 0) failureCounters.delete(sessionId);
}

/** Reset all tool counters for a session (called on session end). */
export function resetToolFailureCounters(sessionId: string): void {
  if (!sessionId) return;
  failureCounters.delete(sessionId);
}

/** Check if tool exceeded threshold. */
export function checkEscalationThreshold(
  sessionId: string,
  toolName: string,
  threshold: number = INCIDENT_ESCALATION_THRESHOLD,
): boolean {
  const inner = getSessionMap(sessionId, false);
  if (!inner) return false;
  const entry = inner.get(toolName);
  if (!entry) return false;
  return entry.count >= threshold;
}

// ---------------------------------------------------------------------------
// Severity map (D15)
// ---------------------------------------------------------------------------

/**
 * Parse `INCIDENT_SEVERITY_MAP` env var (D15).
 *
 * Format: `"bash:high,git:medium,api:critical"`. Whitespace tolerated.
 * Invalid entries warn and fall back to {@link DEFAULT_INCIDENT_SEVERITY}.
 */
export function parseSeverityMap(envValue: string | undefined): Map<string, IncidentSeverity> {
  const map = new Map<string, IncidentSeverity>();
  if (!envValue) return map;
  for (const raw of envValue.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const tool = part.slice(0, idx).trim();
    const sev = part.slice(idx + 1).trim().toLowerCase();
    if (!tool) continue;
    const narrowed = narrowSeverity(sev);
    if (narrowed) {
      map.set(tool, narrowed);
    } else {
      console.warn(
        `[incident-escalation] invalid severity for ${tool}: ${sev}, defaulting to ${DEFAULT_INCIDENT_SEVERITY}`,
      );
      map.set(tool, DEFAULT_INCIDENT_SEVERITY);
    }
  }
  return map;
}

/** Resolve severity for a tool, falling back to {@link DEFAULT_INCIDENT_SEVERITY}. */
export function severityForTool(
  toolName: string,
  map: Map<string, IncidentSeverity>,
): IncidentSeverity {
  return map.get(toolName) ?? DEFAULT_INCIDENT_SEVERITY;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * Escalate to incident if threshold exceeded.
 *
 * Returns the incident id (newly created) or `null` if not escalated.
 * Best-effort: any internal error returns `null` without throwing.
 */
export function escalateToolFailure(
  projectId: string,
  sessionId: string,
  toolName: string,
  threshold: number = INCIDENT_ESCALATION_THRESHOLD,
  rootDir?: string,
): string | null {
  try {
    if (!projectId || !sessionId || !toolName) return null;
    const inner = getSessionMap(sessionId, false);
    if (!inner) return null;
    const entry = inner.get(toolName);
    if (!entry || entry.count < threshold) return null;

    const map = parseSeverityMap(process.env["INCIDENT_SEVERITY_MAP"]);
    const severity = severityForTool(toolName, map);

    const symptoms: string[] = [
      `Tool '${toolName}' failed ${entry.count} time(s) in session ${sessionId}`,
      ...entry.errors.map((e) => `error: ${e}`),
    ];

    const now = nowIso();
    const evidence: IncidentEvidence[] = entry.errors.map((e) => ({
      type: "tool_error",
      value: e,
      collectedAt: now,
    }));

    const id = incidentRecord(
      projectId,
      `Tool failure: ${toolName}`,
      symptoms,
      {
        severity,
        affected: [toolName],
        source: "tool_failure",
        evidence,
        detectedAt: entry.firstAt,
        tags: ["auto-escalated"],
      },
      rootDir,
    );

    // Reset counter so we don't re-escalate immediately.
    inner.delete(toolName);
    if (inner.size === 0) failureCounters.delete(sessionId);

    return id;
  } catch {
    return null;
  }
}

/** Test-only: clear all in-memory counters. */
export function _resetAllFailureCounters(): void {
  failureCounters.clear();
}
