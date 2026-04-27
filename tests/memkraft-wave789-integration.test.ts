/**
 * Wave 7/8/9 final integration smoke (Phase 10).
 *
 * Eight end-to-end scenarios spanning bitemporal facts, decay/tombstone
 * lifecycle, wiki-link graph, document chunking, incident auto-escalation,
 * RCA with runbook suggestions, decision auto-record, and the cross-domain
 * evidence-first search. Each scenario uses a tmp rootDir + ProjectMemory
 * with module-level direct calls so the loop is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import { factAdd, factAt, factHistory } from "../src/memory/facts.js";
import {
  decayApply,
  decayIsTombstoned,
  decayRestore,
  decayTombstone,
} from "../src/memory/decay.js";
import { linkForward, linkGraph, linkOrphans, linkScan } from "../src/memory/links.js";
import { searchPrecise, trackDocument } from "../src/memory/chunking.js";
import {
  _resetAllFailureCounters,
  checkEscalationThreshold,
  escalateToolFailure,
  recordToolFailure,
} from "../src/agent/incident/incident-escalation.js";
import {
  incidentGet,
  incidentRecord,
  incidentSearch,
} from "../src/agent/incident/incident-store.js";
import { decisionGet, decisionRecord } from "../src/agent/decision/decision-store.js";
import { evidenceFirst } from "../src/agent/decision/evidence-first.js";
import { runbookAdd } from "../src/agent/runbook/runbook-store.js";
import { computeRCA } from "../src/agent/rca/rca-engine.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-w789-int-"));
}

describe("MemKraft Wave 7/8/9 — final integration (Phase 10)", () => {
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

  test("S1: Bitemporal facts — Simon Kim role progression CTO → CEO", () => {
    const mem = new ProjectMemory("/tmp/mk-w789-s1", { rootDir: root });

    factAdd(mem, "SimonKim", "role", "CTO", {
      validFrom: "2018-01-01",
      validTo: "2020-02-29",
      recordedAt: "2024-05-10T14:22",
    });
    factAdd(mem, "SimonKim", "role", "CEO", {
      validFrom: "2020-03-01",
      recordedAt: "2026-04-17T00:30",
    });

    const earlyEra = factAt(mem, "SimonKim", "role", { asOf: "2019-06-01" });
    expect(earlyEra).not.toBeNull();
    expect(earlyEra!.value).toBe("CTO");

    const ceoEra = factAt(mem, "SimonKim", "role", { asOf: "2026-01-01" });
    expect(ceoEra).not.toBeNull();
    expect(ceoEra!.value).toBe("CEO");

    const history = factHistory(mem, "SimonKim", "role");
    expect(history).toHaveLength(2);
  });

  test("S2: Decay lifecycle — apply 3x → tombstone → restore", () => {
    const mem = new ProjectMemory("/tmp/mk-w789-s2", { rootDir: root });

    mem.writeEntry({
      name: "weakly_used",
      description: "candidate for decay",
      type: "reference",
      body: "a recall entry not used much",
      filePath: "",
      tier: "recall",
      lastAccessed: "2026-01-01",
    });

    const a1 = decayApply(mem, "weakly_used", { decayRate: 0.5 });
    expect(a1.decayWeight).toBe(0.5);
    expect(a1.decayCount).toBe(1);

    const a2 = decayApply(mem, "weakly_used", { decayRate: 0.5 });
    expect(a2.decayWeight).toBe(0.25);
    expect(a2.decayCount).toBe(2);

    const a3 = decayApply(mem, "weakly_used", { decayRate: 0.5 });
    expect(a3.decayWeight).toBe(0.125);
    expect(a3.decayCount).toBe(3);

    // Soft-delete.
    const tomb = decayTombstone(mem, "weakly_used");
    expect(tomb.tombstoned).toBe(true);
    expect(decayIsTombstoned(mem, "weakly_used")).toBe(true);

    // Restore wipes weight/count and lifts tombstone state.
    const restored = decayRestore(mem, "weakly_used");
    expect(restored.tombstoned).toBe(false);
    expect(restored.decayWeight).toBe(1);
    expect(restored.decayCount).toBe(0);
    expect(decayIsTombstoned(mem, "weakly_used")).toBe(false);
  });

  test("S3: Link graph — 3 cross-referenced files + orphans", () => {
    const mem = new ProjectMemory("/tmp/mk-w789-s3", { rootDir: root });

    mem.writeEntry({
      name: "Alpha",
      description: "alpha node",
      type: "project",
      body: "Mentions [[Bravo]] and [[Charlie]] and [[GhostEntity]].",
      filePath: "",
      tier: "recall",
    });
    mem.writeEntry({
      name: "Bravo",
      description: "bravo node",
      type: "project",
      body: "Refers to [[Charlie]] only.",
      filePath: "",
      tier: "recall",
    });
    mem.writeEntry({
      name: "Charlie",
      description: "charlie node",
      type: "project",
      body: "Terminal — no outbound.",
      filePath: "",
      tier: "recall",
    });

    const scan = linkScan(mem);
    expect(scan.written).toBe(true);

    const fwd = linkForward(mem, "Alpha.md");
    expect(fwd).toContain("Bravo");
    expect(fwd).toContain("Charlie");

    const graph = linkGraph(mem, "Alpha", { hops: 2 });
    expect(graph.nodes).toContain("Alpha");
    expect(graph.nodes).toContain("Bravo");
    expect(graph.nodes).toContain("Charlie");

    const orphans = linkOrphans(mem);
    expect(orphans).toContain("GhostEntity");
    expect(orphans).not.toContain("Bravo");
  });

  test("S4: Chunking + searchPrecise — marker word lands in correct chunk", () => {
    const mem = new ProjectMemory("/tmp/mk-w789-s4", { rootDir: root });

    const words: string[] = [];
    for (let i = 0; i < 1500; i += 1) words.push(`word${i}`);
    words[700] = "kubernetesdeploymentmarker";
    const doc = words.join(" ");

    const result = trackDocument(mem, "doc-w789", doc, {
      chunkSize: 500,
      chunkOverlap: 50,
    });
    expect(result.parentTracked).toBe(true);
    expect(result.chunksCreated).toBeGreaterThanOrEqual(3);
    expect(result.failures).toEqual([]);

    const precise = searchPrecise(mem, "kubernetesdeploymentmarker");
    expect(precise.fallbackUsed).toBe(false);
    expect(precise.results.length).toBeGreaterThan(0);
    expect(precise.results[0]!.name.startsWith("doc-w789__c")).toBe(true);
  });

  test("S5: Incident auto-escalation — 3x bash failure → high incident", () => {
    const projectId = "p-w789-s5";
    const session = "sess-w789";
    const prevEnv = process.env["INCIDENT_SEVERITY_MAP"];
    process.env["INCIDENT_SEVERITY_MAP"] = "bash:high";

    try {
      recordToolFailure(session, "bash", "exit 127");
      recordToolFailure(session, "bash", "exit 127 again");
      recordToolFailure(session, "bash", "third failure");
      expect(checkEscalationThreshold(session, "bash")).toBe(true);

      const id = escalateToolFailure(projectId, session, "bash", 3, root);
      expect(id).not.toBeNull();
      const rec = incidentGet(projectId, id!, root);
      expect(rec).not.toBeNull();
      expect(rec!.severity).toBe("high");
      expect(rec!.affected).toEqual(["bash"]);
      expect(rec!.source).toBe("tool_failure");
      expect(rec!.tags).toContain("auto-escalated");
    } finally {
      if (prevEnv === undefined) {
        delete process.env["INCIDENT_SEVERITY_MAP"];
      } else {
        process.env["INCIDENT_SEVERITY_MAP"] = prevEnv;
      }
    }
  });

  test("S6: RCA full flow — hypotheses scored + suggested runbook", async () => {
    const projectId = "p-w789-s6";

    const incidentId = incidentRecord(
      projectId,
      "Connection timeout while running tests",
      [
        "test runner times out after 30s",
        "DNS resolution slow for staging endpoint",
      ],
      {
        severity: "high",
        affected: ["test-runner"],
        source: "manual",
        evidence: [
          { type: "stderr", value: "Timeout exceeded", collectedAt: new Date().toISOString() },
          { type: "stderr", value: "ECONNRESET on api.staging", collectedAt: new Date().toISOString() },
        ],
        hypothesis: [
          "Network latency on staging cluster",
          "Stale DNS cache on CI node",
        ],
      },
      root,
    );

    runbookAdd(
      projectId,
      "Connection timeout",
      ["Flush DNS cache", "Retry with longer timeout"],
      {
        confidence: 0.7,
        cause: "stale DNS cache",
        verification: "tests pass in <30s",
        tags: ["network"],
      },
      root,
    );

    const report = await computeRCA(projectId, incidentId, undefined, root);
    expect(report.incidentId).toBe(incidentId);
    expect(report.symptomCount).toBe(2);
    expect(report.evidenceCount).toBe(2);
    expect(report.hypotheses.length).toBe(2);
    // hypotheses scored desc
    if (report.hypotheses.length >= 2) {
      expect(report.hypotheses[0]!.score).toBeGreaterThanOrEqual(report.hypotheses[1]!.score);
    }
    expect(report.suggestedRunbooks.length).toBeGreaterThan(0);
    expect(report.suggestedRunbooks[0]!.runbook.pattern.toLowerCase()).toContain("connection timeout");
  });

  test("S7: Decision auto-record — convergence-gate trigger persists", () => {
    const projectId = "p-w789-s7";

    const id = decisionRecord(
      projectId,
      "Adopt convergence-gate before commit",
      "Reduces flaky-test churn before main branch merge",
      "Run convergence_check; only commit if status=accepted",
      {
        source: "auto-convergence",
        tags: ["plan-execute", "convergence"],
        outcome: "Initial trial accepted",
      },
      root,
    );

    expect(id).toMatch(/^dec-/);
    const rec = decisionGet(projectId, id, root);
    expect(rec).not.toBeNull();
    expect(rec!.source).toBe("auto-convergence");
    expect(rec!.status).toBe("accepted");
    expect(rec!.tags).toContain("convergence");
    expect(rec!.what).toBe("Adopt convergence-gate before commit");
  });

  test("S8: evidenceFirst — cross-domain memory + incident + decision", async () => {
    const projectId = "p-w789-s8";
    const mem = new ProjectMemory(projectId, { rootDir: root });

    // Seed memory recall via session-recall (memory domain in evidenceFirst).
    const { indexSession } = await import("../src/memory/session-recall.js");
    indexSession({
      projectId: mem.projectId,
      sessionId: "sess-timeout-evidence",
      messages: [
        { role: "user", content: "We hit a timeout on the staging deploy." } as any,
        { role: "assistant", content: "I bumped the retry, the timeout cleared." } as any,
      ],
      rootDir: root,
    });

    // Seed an incident with the keyword.
    incidentRecord(
      mem.projectId,
      "Staging timeout incident",
      ["api.staging timeout", "30s deadline exceeded"],
      { severity: "medium", affected: ["api"], source: "manual" },
      root,
    );

    // Seed a decision with the keyword.
    decisionRecord(
      mem.projectId,
      "Increase staging timeout to 60s",
      "Fewer false positives on CI for transient network blips",
      "Update timeout config in staging.yml; revisit after 1 month",
      { tags: ["timeout"] },
      root,
    );

    const result = await evidenceFirst(mem.projectId, "timeout", { limit: 20, rootDir: root });
    expect(result.counts.memory).toBeGreaterThan(0);
    expect(result.counts.incident).toBeGreaterThan(0);
    expect(result.counts.decision).toBeGreaterThan(0);

    const sources = new Set(result.results.map((r) => r._source));
    expect(sources.has("memory")).toBe(true);
    expect(sources.has("incident")).toBe(true);
    expect(sources.has("decision")).toBe(true);

    // also the incident/decision search routes work standalone (sanity)
    const incs = incidentSearch(mem.projectId, { query: "timeout" }, root);
    expect(incs.length).toBeGreaterThan(0);
  });
});
