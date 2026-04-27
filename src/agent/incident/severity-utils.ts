/**
 * Incident severity narrowing helpers (Wave 10 P0 F2).
 *
 * Use at user-input boundaries (CLI, tool input, env vars) to convert
 * arbitrary strings into the narrow `IncidentSeverity` literal type
 * without unsafe `as` casts.
 */

import type { IncidentSeverity } from "./types.js";

const VALID_SEVERITIES: ReadonlyArray<IncidentSeverity> = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

/**
 * Narrow a string to IncidentSeverity, or undefined if invalid.
 * Use this at user-input boundaries (CLI, tool input) to prevent unsafe casts.
 */
export function narrowSeverity(value: unknown): IncidentSeverity | undefined {
  if (typeof value !== "string") return undefined;
  return (VALID_SEVERITIES as ReadonlyArray<string>).includes(value)
    ? (value as IncidentSeverity)
    : undefined;
}

/** Like narrowSeverity but returns a default when invalid. */
export function narrowSeverityOrDefault(
  value: unknown,
  fallback: IncidentSeverity = "medium",
): IncidentSeverity {
  return narrowSeverity(value) ?? fallback;
}

/** Type guard. */
export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return narrowSeverity(value) !== undefined;
}

export { VALID_SEVERITIES };
