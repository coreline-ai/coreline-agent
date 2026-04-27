/**
 * Phase 9 (Wave 9) — RCA Engine tests (heuristic only).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  incidentGet,
  incidentRecord,
  incidentUpdate,
} from "../src/agent/incident/incident-store.js";
import { runbookAdd } from "../src/agent/runbook/runbook-store.js";
import { computeRCA } from "../src/agent/rca/rca-engine.js";
import {
  scoreAllHypotheses,
  scoreHypothesis,
} from "../src/agent/rca/hypothesis-scorer.js";
import { findRelatedIncidents } from "../src/agent/rca/related-incidents.js";
import type { IncidentRecord } from "../src/agent/incident/types.js";

const PROJECT_ID = "p-rca-test";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "rca-engine-"));
}

let root: string;

beforeEach(() => {
  root = mkTmp();
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("RCA Engine — Phase 9 / Wave 9", () => {
  test("TC-9.1: confirmed hypothesis scored 0.95", () => {
    const incidentId = incidentRecord(
      PROJECT_ID,
      "API outage",
      ["503 spike"],
      { hypothesis: ["upstream timeout"] },
      root,
    );
    incidentUpdate(
      PROJECT_ID,
      incidentId,
      { confirmHypothesis: ["upstream timeout"] },
      root,
    );
    const incident = incidentGet(PROJECT_ID, incidentId, root)!;
    const scored = scoreAllHypotheses(incident);
    expect(scored.length).toBeGreaterThan(0);
    const confirmed = scored.find((s) => s.status === "confirmed");
    expect(confirmed).toBeDefined();
    expect(confirmed!.score).toBe(0.95);
  });

  test("TC-9.2: rejected hypothesis scored 0.05", () => {
    const incidentId = incidentRecord(
      PROJECT_ID,
      "DB lag",
      ["replication slow"],
      { hypothesis: ["network partition"] },
      root,
    );
    incidentUpdate(
      PROJECT_ID,
      incidentId,
      { rejectHypothesis: ["network partition"] },
      root,
    );
    const incident = incidentGet(PROJECT_ID, incidentId, root)!;
    const scored = scoreAllHypotheses(incident);
    const rejected = scored.find((s) => s.status === "rejected");
    expect(rejected).toBeDefined();
    expect(rejected!.score).toBe(0.05);
  });

  test("TC-9.3: testing with high symptom similarity → score >= 0.6", () => {
    const incidentId = incidentRecord(
      PROJECT_ID,
      "Pool exhaustion",
      ["database connection pool exhausted"],
      { hypothesis: ["database connection pool exhausted by long queries"] },
      root,
    );
    const incident = incidentGet(PROJECT_ID, incidentId, root)!;
    const scored = scoreAllHypotheses(incident);
    const testing = scored.find((s) => s.status === "testing");
    expect(testing).toBeDefined();
    expect(testing!.score).toBeGreaterThanOrEqual(0.6);
  });

  test("TC-9.4: testing with 5 evidence items → bonus 0.25, capped at 0.9", () => {
    const incidentId = incidentRecord(
      PROJECT_ID,
      "Disk full",
      ["disk full on /var"],
      {
        hypothesis: ["disk full on /var"],
        evidence: [
          { type: "log", value: "ENOSPC e1", collectedAt: "" },
          { type: "log", value: "ENOSPC e2", collectedAt: "" },
          { type: "log", value: "ENOSPC e3", collectedAt: "" },
          { type: "log", value: "ENOSPC e4", collectedAt: "" },
          { type: "log", value: "ENOSPC e5", collectedAt: "" },
        ],
      },
      root,
    );
    const incident = incidentGet(PROJECT_ID, incidentId, root)!;
    const scored = scoreAllHypotheses(incident);
    const testing = scored.find((s) => s.status === "testing");
    expect(testing).toBeDefined();
    expect(testing!.score).toBe(0.9);
  });

  test("TC-9.5: testing with no symptoms → score = max(0.3, 0) + bonus", () => {
    // We need an incident with hypotheses but no symptoms — symptoms required by API,
    // so exercise scoreHypothesis directly with a synthesized record.
    const synth: IncidentRecord = {
      id: "inc-test",
      title: "t",
      severity: "low",
      status: "open",
      detectedAt: "",
      validFrom: "",
      recordedAt: "",
      tier: "core",
      source: "manual",
      affected: [],
      tags: [],
      symptoms: [],
      evidence: [],
      hypotheses: [{ text: "abc xyz", status: "testing", notedAt: "" }],
      related: [],
    };
    const scored = scoreHypothesis(synth.hypotheses[0]!, synth, 0);
    expect(scored.score).toBe(0.3);

    const scored2 = scoreHypothesis(synth.hypotheses[0]!, synth, 2);
    // 0.3 + min(0.25, 0.10) = 0.4
    expect(scored2.score).toBeCloseTo(0.4, 4);
  });

  test("TC-9.6: scoreAllHypotheses returns sorted desc", () => {
    const incidentId = incidentRecord(
      PROJECT_ID,
      "mixed",
      ["unrelated symptom"],
      { hypothesis: ["h1", "h2", "h3"] },
      root,
    );
    incidentUpdate(
      PROJECT_ID,
      incidentId,
      { confirmHypothesis: ["h1"], rejectHypothesis: ["h3"] },
      root,
    );
    const incident = incidentGet(PROJECT_ID, incidentId, root)!;
    const scored = scoreAllHypotheses(incident);
    expect(scored.length).toBe(3);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score);
    }
    expect(scored[0]!.status).toBe("confirmed");
    expect(scored[scored.length - 1]!.status).toBe("rejected");
  });

  test("TC-9.7: findRelatedIncidents returns similar peers (similarity > 0.2)", () => {
    const targetId = incidentRecord(
      PROJECT_ID,
      "DB pool exhausted",
      ["database connection pool exhausted"],
      { affected: ["api", "db"] },
      root,
    );
    incidentRecord(
      PROJECT_ID,
      "DB pool issue again",
      ["database connection pool exhausted on prod"],
      { affected: ["api", "db"] },
      root,
    );
    incidentRecord(
      PROJECT_ID,
      "Similar pool problem",
      ["connection pool exhausted in db"],
      { affected: ["db"] },
      root,
    );
    const target = incidentGet(PROJECT_ID, targetId, root)!;
    const related = findRelatedIncidents(PROJECT_ID, target, 5, root);
    expect(related.length).toBe(2);
    for (const r of related) {
      expect(r.similarity).toBeGreaterThan(0.2);
    }
  });

  test("TC-9.8: findRelatedIncidents excludes input incident itself", () => {
    const targetId = incidentRecord(
      PROJECT_ID,
      "alpha",
      ["alpha symptom"],
      undefined,
      root,
    );
    const target = incidentGet(PROJECT_ID, targetId, root)!;
    const related = findRelatedIncidents(PROJECT_ID, target, 5, root);
    for (const r of related) {
      expect(r.incidentId).not.toBe(targetId);
    }
  });

  test("TC-9.9: computeRCA returns all required fields populated", async () => {
    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable"],
      {
        hypothesis: ["upstream down"],
        severity: "high",
        evidence: [{ type: "log", value: "503", collectedAt: "" }],
      },
      root,
    );
    const report = await computeRCA(PROJECT_ID, id, undefined, root);
    expect(report.incidentId).toBe(id);
    expect(report.strategy).toBe("heuristic");
    expect(report.severity).toBe("high");
    expect(report.status).toBe("open");
    expect(Array.isArray(report.hypotheses)).toBe(true);
    expect(report.hypotheses.length).toBe(1);
    expect(Array.isArray(report.suggestedRunbooks)).toBe(true);
    expect(Array.isArray(report.relatedIncidents)).toBe(true);
    expect(report.evidenceCount).toBe(1);
    expect(report.symptomCount).toBe(1);
  });

  test("TC-9.10: computeRCA suggestedRunbooks contains a matching runbook", async () => {
    runbookAdd(
      PROJECT_ID,
      "service unavailable upstream",
      ["restart upstream", "verify health"],
      { confidence: 0.8 },
      root,
    );
    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable upstream"],
      undefined,
      root,
    );
    const report = await computeRCA(PROJECT_ID, id, undefined, root);
    expect(report.suggestedRunbooks.length).toBeGreaterThan(0);
    expect(report.suggestedRunbooks[0]!.runbook.pattern).toContain("service unavailable");
  });

  test("TC-9.11: strategy:'llm' with RCA_LLM_ENABLED off → falls back to heuristic", async () => {
    const prev = process.env.RCA_LLM_ENABLED;
    delete process.env.RCA_LLM_ENABLED;
    try {
      const id = incidentRecord(
        PROJECT_ID,
        "x",
        ["s"],
        { hypothesis: ["h"] },
        root,
      );
      const report = await computeRCA(
        PROJECT_ID,
        id,
        { strategy: "llm" },
        root,
      );
      // Fallback path: report.strategy reflects what actually executed.
      expect(report.strategy).toBe("heuristic");
      expect(report.hypotheses.length).toBe(1);
    } finally {
      if (prev !== undefined) process.env.RCA_LLM_ENABLED = prev;
    }
  });

  test("TC-9.12: non-existent incidentId throws Error", async () => {
    await expect(
      computeRCA(PROJECT_ID, "inc-19700101-000000-deadbeef", undefined, root),
    ).rejects.toThrow(/Incident not found/);
  });

  test("TC-9.13: includeRelated:false → relatedIncidents = []", async () => {
    const targetId = incidentRecord(
      PROJECT_ID,
      "DB pool exhausted",
      ["database connection pool exhausted"],
      undefined,
      root,
    );
    incidentRecord(
      PROJECT_ID,
      "DB pool issue again",
      ["database connection pool exhausted on prod"],
      undefined,
      root,
    );
    const report = await computeRCA(
      PROJECT_ID,
      targetId,
      { includeRelated: false },
      root,
    );
    expect(report.relatedIncidents).toEqual([]);
  });

  test("TC-9.14: maxRunbooks:1 → suggestedRunbooks length <= 1", async () => {
    runbookAdd(PROJECT_ID, "alpha symptom", ["s1"], { confidence: 0.6 }, root);
    runbookAdd(PROJECT_ID, "alpha symptom variant", ["s2"], { confidence: 0.7 }, root);
    runbookAdd(PROJECT_ID, "alpha symptom alt form", ["s3"], { confidence: 0.5 }, root);
    const id = incidentRecord(
      PROJECT_ID,
      "alpha case",
      ["alpha symptom"],
      undefined,
      root,
    );
    const report = await computeRCA(PROJECT_ID, id, { maxRunbooks: 1 }, root);
    expect(report.suggestedRunbooks.length).toBeLessThanOrEqual(1);
  });

  test("TC-9.15: runbook stats not mutated by RCA (touch:false)", async () => {
    const rbId = runbookAdd(
      PROJECT_ID,
      "service unavailable upstream",
      ["restart"],
      { confidence: 0.8 },
      root,
    );
    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable upstream"],
      undefined,
      root,
    );
    const report = await computeRCA(PROJECT_ID, id, undefined, root);
    expect(report.suggestedRunbooks.length).toBeGreaterThan(0);
    expect(report.suggestedRunbooks[0]!.runbook.id).toBe(rbId);
    // usageCount must remain 0 (touch:false)
    expect(report.suggestedRunbooks[0]!.runbook.usageCount).toBe(0);
    expect(report.suggestedRunbooks[0]!.runbook.lastMatched).toBeUndefined();
  });
});
