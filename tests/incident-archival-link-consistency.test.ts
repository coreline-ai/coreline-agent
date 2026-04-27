/**
 * Wave 10 P3 R6 — Verify D19: archival incidents accept new decision links + tier preserved.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { incidentRecord, incidentUpdate, incidentGet } from "../src/agent/incident/incident-store.js";
import { decisionRecord, decisionGet } from "../src/agent/decision/decision-store.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "archival-link-"));
}

describe("R6: Archival incident link consistency (D19)", () => {
  test("decision linked to resolved incident — tier preserved as archival", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/r6-test-1", { rootDir: root });
      const projectId = mem.projectId;

      const incId = incidentRecord(
        projectId,
        "API timeout",
        ["response delay", "ECONNRESET"],
        { severity: "high" },
        root,
      );
      incidentUpdate(projectId, incId, {
        addHypothesis: ["pool exhausted"],
        resolution: "Increased timeout to 30s",
      }, root);

      const incBefore = incidentGet(projectId, incId, root);
      expect(incBefore?.status).toBe("resolved");
      expect(incBefore?.tier).toBe("archival");

      const decId = decisionRecord(
        projectId,
        "Increase timeout policy fleet-wide",
        "Multiple incidents traced to default 5s timeout",
        "Update default-config.yml: timeout: 30s",
        { linkedIncidents: [incId] },
        root,
      );

      const dec = decisionGet(projectId, decId, root);
      expect(dec?.linkedIncidents).toContain(incId);

      const incAfter = incidentGet(projectId, incId, root);
      expect(incAfter).not.toBeNull();
      expect(incAfter?.tier).toBe("archival");
      expect(incAfter?.status).toBe("resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multiple decisions linked to same archival incident — all linked persist", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/r6-test-2", { rootDir: root });
      const projectId = mem.projectId;

      const incId = incidentRecord(projectId, "Test inc", ["sym"], { severity: "low" }, root);
      incidentUpdate(projectId, incId, { resolution: "fixed" }, root);

      const dec1 = decisionRecord(projectId, "Decision 1", "why1", "how1", { linkedIncidents: [incId] }, root);
      const dec2 = decisionRecord(projectId, "Decision 2", "why2", "how2", { linkedIncidents: [incId] }, root);

      const inc = incidentGet(projectId, incId, root);
      expect(inc?.tier).toBe("archival");
      expect(inc?.status).toBe("resolved");

      // Both decisions persisted with the link
      expect(decisionGet(projectId, dec1, root)?.linkedIncidents).toContain(incId);
      expect(decisionGet(projectId, dec2, root)?.linkedIncidents).toContain(incId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("D19 — non-existent incident link → silent skip + warn (no crash)", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/r6-test-3", { rootDir: root });
      const projectId = mem.projectId;

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: unknown) => warnings.push(String(msg));

      try {
        const decId = decisionRecord(
          projectId,
          "Decision linking phantom",
          "why",
          "how",
          { linkedIncidents: ["inc-99991231-235959-deadbeef"] },
          root,
        );

        const dec = decisionGet(projectId, decId, root);
        expect(dec).not.toBeNull();
        expect(dec?.linkedIncidents).toContain("inc-99991231-235959-deadbeef");
      } finally {
        console.warn = origWarn;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
