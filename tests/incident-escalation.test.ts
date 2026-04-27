/**
 * Phase 6 (Wave 8) — Incident escalation (tool failure → incident) tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetAllFailureCounters,
  checkEscalationThreshold,
  escalateToolFailure,
  parseSeverityMap,
  recordToolFailure,
  resetToolFailure,
  resetToolFailureCounters,
  severityForTool,
} from "../src/agent/incident/incident-escalation.js";
import { incidentGet } from "../src/agent/incident/incident-store.js";

const PROJECT_ID = "p-incident-esc";
const SESSION = "sess-1";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "incident-esc-"));
}

let root: string;

beforeEach(() => {
  root = mkTmp();
  _resetAllFailureCounters();
});

afterEach(() => {
  _resetAllFailureCounters();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("Incident escalation — Phase 6 / Wave 8", () => {
  test("TC-6.13: 3 consecutive recordToolFailure → checkEscalationThreshold true", () => {
    expect(checkEscalationThreshold(SESSION, "bash")).toBe(false);
    recordToolFailure(SESSION, "bash", "err1");
    expect(checkEscalationThreshold(SESSION, "bash")).toBe(false);
    recordToolFailure(SESSION, "bash", "err2");
    expect(checkEscalationThreshold(SESSION, "bash")).toBe(false);
    const c = recordToolFailure(SESSION, "bash", "err3");
    expect(c).toBe(3);
    expect(checkEscalationThreshold(SESSION, "bash")).toBe(true);
  });

  test("TC-6.14: resetToolFailure clears single tool counter", () => {
    recordToolFailure(SESSION, "bash", "err1");
    recordToolFailure(SESSION, "bash", "err2");
    recordToolFailure(SESSION, "bash", "err3");
    recordToolFailure(SESSION, "git", "g1");
    resetToolFailure(SESSION, "bash");
    expect(checkEscalationThreshold(SESSION, "bash")).toBe(false);
    // git remains
    expect(checkEscalationThreshold(SESSION, "git", 1)).toBe(true);
  });

  test("TC-6.15: resetToolFailureCounters clears all counters for session", () => {
    recordToolFailure(SESSION, "bash", "e");
    recordToolFailure(SESSION, "bash", "e");
    recordToolFailure(SESSION, "bash", "e");
    recordToolFailure(SESSION, "git", "e");
    recordToolFailure("sess-2", "bash", "e");
    resetToolFailureCounters(SESSION);
    expect(checkEscalationThreshold(SESSION, "bash")).toBe(false);
    expect(checkEscalationThreshold(SESSION, "git", 1)).toBe(false);
    // session 2 still tracked
    expect(checkEscalationThreshold("sess-2", "bash", 1)).toBe(true);
  });

  test("TC-6.16: parseSeverityMap parses + handles invalid", () => {
    const map = parseSeverityMap("bash:high, git:medium ,api:critical,bad:nope");
    expect(map.get("bash")).toBe("high");
    expect(map.get("git")).toBe("medium");
    expect(map.get("api")).toBe("critical");
    // invalid severity falls back to default
    expect(map.get("bad")).toBe("medium");
    // empty input
    expect(parseSeverityMap(undefined).size).toBe(0);
    expect(parseSeverityMap("").size).toBe(0);
  });

  test("TC-6.17: severityForTool fallback for unknown", () => {
    const map = parseSeverityMap("bash:high");
    expect(severityForTool("bash", map)).toBe("high");
    expect(severityForTool("nonexistent", map)).toBe("medium");
  });

  test("TC-6.18: escalateToolFailure creates incident with correct severity", () => {
    const prevEnv = process.env["INCIDENT_SEVERITY_MAP"];
    process.env["INCIDENT_SEVERITY_MAP"] = "bash:critical";
    try {
      // Below threshold
      recordToolFailure(SESSION, "bash", "e1");
      recordToolFailure(SESSION, "bash", "e2");
      const earlyId = escalateToolFailure(PROJECT_ID, SESSION, "bash", 3, root);
      expect(earlyId).toBeNull();

      // Threshold met
      recordToolFailure(SESSION, "bash", "e3");
      const id = escalateToolFailure(PROJECT_ID, SESSION, "bash", 3, root);
      expect(id).not.toBeNull();
      const rec = incidentGet(PROJECT_ID, id!, root);
      expect(rec).not.toBeNull();
      expect(rec!.severity).toBe("critical");
      expect(rec!.affected).toEqual(["bash"]);
      expect(rec!.source).toBe("tool_failure");
      expect(rec!.evidence.length).toBeGreaterThan(0);
      expect(rec!.tags).toContain("auto-escalated");

      // Counter reset
      expect(checkEscalationThreshold(SESSION, "bash", 3)).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env["INCIDENT_SEVERITY_MAP"];
      else process.env["INCIDENT_SEVERITY_MAP"] = prevEnv;
    }
  });
});
