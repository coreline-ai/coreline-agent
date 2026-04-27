/**
 * Integration tests for severity narrowing at the incident-store boundary
 * (Wave 10 P0 F2). Verifies that bogus severity input falls back to "medium"
 * with a console.warn instead of throwing.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  incidentRecord,
  incidentUpdate,
} from "../src/agent/incident/incident-store.js";
import type { IncidentSeverity } from "../src/agent/incident/types.js";

const PROJECT_ID = "p-incident-severity-narrow";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "incident-sev-narrow-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("incident severity narrowing — integration", () => {
  test("incidentUpdate with bogus severity falls back to 'medium' and warns", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const id = incidentRecord(
        PROJECT_ID,
        "Test incident",
        ["symptom"],
        { severity: "high" },
        root,
      );

      const updated = incidentUpdate(
        PROJECT_ID,
        id,
        { severity: "bogus" as IncidentSeverity },
        root,
      );

      expect(updated.severity).toBe("medium");
      expect(warnSpy).toHaveBeenCalled();
      const calledWith = warnSpy.mock.calls.flat().join(" ");
      expect(calledWith).toContain("invalid severity");
      expect(calledWith).toContain("medium");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("incidentRecord with bogus severity falls back to 'medium' and warns", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const id = incidentRecord(
        PROJECT_ID,
        "Test bogus",
        ["symptom"],
        { severity: "BOGUS" as unknown as IncidentSeverity },
        root,
      );

      expect(id).toMatch(/^inc-/);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
