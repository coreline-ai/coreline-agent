/**
 * Phase 6 (Wave 8) — Incident Memory Layer store tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  incidentGet,
  incidentRecord,
  incidentSearch,
  incidentUpdate,
} from "../src/agent/incident/incident-store.js";
import { getIncidentsDir } from "../src/config/paths.js";

const PROJECT_ID = "p-incident-test";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "incident-store-"));
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

describe("Incident Store — Phase 6 / Wave 8", () => {
  test("TC-6.1: incidentRecord creates file with frontmatter + sections", () => {
    const id = incidentRecord(
      PROJECT_ID,
      "API outage",
      ["503 errors observed", "P95 latency spike"],
      {
        evidence: [
          { type: "stderr", value: "ECONNRESET", collectedAt: "2026-04-25T12:00:00Z" },
        ],
        hypothesis: ["proxy timeout"],
        severity: "high",
      },
      root,
    );

    expect(id).toMatch(/^inc-\d{8}-\d{6}-[a-f0-9]{8}$/);
    const dir = getIncidentsDir(PROJECT_ID, root);
    const files = readdirSync(dir);
    expect(files).toContain(`${id}.md`);

    const content = readFileSync(join(dir, `${id}.md`), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain("type: incident");
    expect(content).toContain("severity: high");
    expect(content).toContain("status: open");
    expect(content).toContain(`# Incident: API outage`);
    expect(content).toContain("## Symptoms");
    expect(content).toContain("- 503 errors observed");
    expect(content).toContain("## Evidence");
    expect(content).toContain("[stderr]");
    expect(content).toContain("ECONNRESET");
    expect(content).toContain("## Hypotheses");
    expect(content).toContain("[testing");
    expect(content).toContain("proxy timeout");
  });

  test("TC-6.2: incidentUpdate appends symptoms (deduped)", () => {
    const id = incidentRecord(PROJECT_ID, "DB lag", ["replication slow"], undefined, root);
    incidentUpdate(
      PROJECT_ID,
      id,
      { addSymptoms: ["disk IO saturated", "replication slow"] },
      root,
    );
    const rec = incidentGet(PROJECT_ID, id, root)!;
    expect(rec.symptoms).toEqual(["replication slow", "disk IO saturated"]);
  });

  test("TC-6.3: confirmHypothesis transitions testing→confirmed", () => {
    const id = incidentRecord(
      PROJECT_ID,
      "Build flaky",
      ["random test failures"],
      { hypothesis: ["timing race", "DNS"] },
      root,
    );
    const updated = incidentUpdate(
      PROJECT_ID,
      id,
      { confirmHypothesis: ["timing race"] },
      root,
    );
    const timing = updated.hypotheses.find((h) => h.text.includes("timing race"));
    const dns = updated.hypotheses.find((h) => h.text.includes("DNS"));
    expect(timing?.status).toBe("confirmed");
    expect(dns?.status).toBe("testing");
  });

  test("TC-6.4: resolution → status:resolved, tier:archival, resolvedAt set", () => {
    const id = incidentRecord(PROJECT_ID, "Cache miss", ["slow reads"], undefined, root);
    const updated = incidentUpdate(
      PROJECT_ID,
      id,
      { resolution: "Bumped cache TTL" },
      root,
    );
    expect(updated.status).toBe("resolved");
    expect(updated.tier).toBe("archival");
    expect(updated.resolvedAt).toBeDefined();
    expect(updated.resolvedAt!.length).toBeGreaterThan(0);
    expect(updated.validTo).toBeDefined();
    expect(updated.resolution).toContain("Bumped cache TTL");
  });

  test("TC-6.5: incidentSearch by severity", () => {
    incidentRecord(PROJECT_ID, "low-1", ["s"], { severity: "low" }, root);
    incidentRecord(PROJECT_ID, "high-1", ["s"], { severity: "high" }, root);
    incidentRecord(PROJECT_ID, "high-2", ["s"], { severity: "high" }, root);
    const results = incidentSearch(PROJECT_ID, { severity: "high" }, root);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.severity === "high")).toBe(true);
  });

  test("TC-6.6: incidentSearch by status", () => {
    incidentRecord(PROJECT_ID, "open-a", ["s"], undefined, root);
    incidentRecord(
      PROJECT_ID,
      "resolved-b",
      ["s"],
      { resolution: "fixed" },
      root,
    );
    const open = incidentSearch(PROJECT_ID, { status: "open" }, root);
    const resolved = incidentSearch(PROJECT_ID, { status: "resolved" }, root);
    expect(open.length).toBe(1);
    expect(open[0]!.title).toBe("open-a");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.title).toBe("resolved-b");
  });

  test("TC-6.7: incidentSearch by timeframe", () => {
    incidentRecord(
      PROJECT_ID,
      "old",
      ["s"],
      { detectedAt: "2025-01-01T00:00:00Z" },
      root,
    );
    incidentRecord(
      PROJECT_ID,
      "mid",
      ["s"],
      { detectedAt: "2026-04-15T00:00:00Z" },
      root,
    );
    incidentRecord(
      PROJECT_ID,
      "new",
      ["s"],
      { detectedAt: "2026-04-25T00:00:00Z" },
      root,
    );
    const results = incidentSearch(
      PROJECT_ID,
      { timeframe: ["2026-04-01T00:00:00Z", "2026-04-20T00:00:00Z"] },
      root,
    );
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("mid");
  });

  test("TC-6.8: incidentSearch by query (title substring, case-insensitive)", () => {
    incidentRecord(PROJECT_ID, "Database Replication Lag", ["lag"], undefined, root);
    incidentRecord(PROJECT_ID, "Cache Miss Spike", ["miss"], undefined, root);
    const results = incidentSearch(PROJECT_ID, { query: "REPLICATION" }, root);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Database Replication Lag");
  });

  test("TC-6.9: incidentGet non-existent → null", () => {
    expect(incidentGet(PROJECT_ID, "inc-19990101-000000-deadbeef", root)).toBeNull();
  });

  test("TC-6.10: incidentGet existing → full record", () => {
    const id = incidentRecord(
      PROJECT_ID,
      "Auth flapping",
      ["403 spikes"],
      { evidence: [{ type: "log", value: "JWT expired", collectedAt: "2026-04-25T10:00:00Z" }] },
      root,
    );
    const rec = incidentGet(PROJECT_ID, id, root);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe(id);
    expect(rec!.title).toBe("Auth flapping");
    expect(rec!.symptoms).toEqual(["403 spikes"]);
    expect(rec!.evidence.length).toBe(1);
    expect(rec!.evidence[0]!.type).toBe("log");
    expect(rec!.evidence[0]!.value).toBe("JWT expired");
  });

  test("TC-6.11: open incidents have tier:core, resolved have tier:archival", () => {
    const openId = incidentRecord(PROJECT_ID, "open-c", ["s"], undefined, root);
    const resolvedId = incidentRecord(
      PROJECT_ID,
      "resolved-c",
      ["s"],
      { resolution: "done" },
      root,
    );
    const openRec = incidentGet(PROJECT_ID, openId, root)!;
    const resolvedRec = incidentGet(PROJECT_ID, resolvedId, root)!;
    expect(openRec.tier).toBe("core");
    expect(resolvedRec.tier).toBe("archival");
  });

  test("TC-6.12: limit defaults to 20", () => {
    for (let i = 0; i < 25; i++) {
      incidentRecord(
        PROJECT_ID,
        `inc-${i}`,
        ["s"],
        { detectedAt: new Date(2026, 0, i + 1).toISOString() },
        root,
      );
    }
    const all = incidentSearch(PROJECT_ID, undefined, root);
    expect(all.length).toBe(20);
    const explicit = incidentSearch(PROJECT_ID, { limit: 50 }, root);
    expect(explicit.length).toBe(25);
  });
});
