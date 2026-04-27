/**
 * Phase 8 (Wave 9) — Runbook Store tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runbookAdd,
  runbookGet,
  runbookList,
  runbookMatch,
} from "../src/agent/runbook/runbook-store.js";
import { getRunbooksDir } from "../src/config/paths.js";

const PROJECT_ID = "p-runbook-test";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "runbook-store-"));
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

describe("Runbook Store — Phase 8 / Wave 9", () => {
  test("TC-8.1: runbookAdd creates file with all sections", () => {
    const id = runbookAdd(
      PROJECT_ID,
      "DB connection pool exhaustion",
      ["Increase pool size", "Recycle stale connections"],
      {
        confidence: 0.8,
        cause: "Long-running queries blocking pool",
        evidenceCmd: "psql -c 'SELECT count(*) FROM pg_stat_activity'",
        fixAction: "ALTER SYSTEM SET max_connections = 200",
        verification: "curl -f http://localhost:8080/health",
        tags: ["db", "pool"],
      },
      root,
    );

    expect(id).toMatch(/^rb-[a-f0-9]{8}$/);

    const dir = getRunbooksDir(PROJECT_ID, root);
    const files = readdirSync(dir);
    expect(files).toContain(`${id}.md`);

    const content = readFileSync(join(dir, `${id}.md`), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain("type: runbook");
    expect(content).toContain("pattern: DB connection pool exhaustion");
    expect(content).toContain("confidence: 0.8");
    expect(content).toContain("usageCount: 0");
    expect(content).toContain("tier: recall");
    expect(content).toContain(`# Runbook: DB connection pool exhaustion`);
    expect(content).toContain("## Symptom");
    expect(content).toContain("DB connection pool exhaustion");
    expect(content).toContain("## Cause");
    expect(content).toContain("Long-running queries blocking pool");
    expect(content).toContain("## Steps");
    expect(content).toContain("1. Increase pool size");
    expect(content).toContain("2. Recycle stale connections");
    expect(content).toContain("## Evidence Command");
    expect(content).toContain("pg_stat_activity");
    expect(content).toContain("## Fix Action");
    expect(content).toContain("max_connections");
    expect(content).toContain("## Verification");
    expect(content).toContain("/health");
  });

  test("TC-8.2: runbookMatch with similar pattern → similarity > 0.3", () => {
    runbookAdd(
      PROJECT_ID,
      "connection pool exhaustion",
      ["restart service"],
      { confidence: 0.6 },
      root,
    );

    const matches = runbookMatch(
      PROJECT_ID,
      "connection pool full",
      { touch: false },
      root,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.similarity).toBeGreaterThan(0.3);
    expect(matches[0]!.score).toBeGreaterThan(0.2);
    expect(matches[0]!.isRegexMatch).toBe(false);
  });

  test("TC-8.3: regex pattern → similarity 1.0 on hit", () => {
    runbookAdd(
      PROJECT_ID,
      "API timeout: .*",
      ["check upstream", "retry with backoff"],
      { confidence: 0.7 },
      root,
    );

    const matches = runbookMatch(
      PROJECT_ID,
      "API timeout: 30s on /v1/users",
      { touch: false },
      root,
    );
    expect(matches.length).toBe(1);
    expect(matches[0]!.similarity).toBe(1.0);
    expect(matches[0]!.isRegexMatch).toBe(true);
  });

  test("TC-8.4: touch:true → usageCount+1, confidence +0.02 capped at 1.0", () => {
    const id = runbookAdd(
      PROJECT_ID,
      "redis OOM",
      ["flush keys", "increase maxmemory"],
      { confidence: 0.99 },
      root,
    );

    const before = runbookGet(PROJECT_ID, id, root)!;
    expect(before.usageCount).toBe(0);
    expect(before.confidence).toBeCloseTo(0.99);

    const matches = runbookMatch(PROJECT_ID, "redis OOM", { touch: true }, root);
    expect(matches.length).toBe(1);

    const after = runbookGet(PROJECT_ID, id, root)!;
    expect(after.usageCount).toBe(1);
    // 0.99 + 0.02 → capped at 1.0
    expect(after.confidence).toBe(1.0);
    expect(after.lastMatched).toBeDefined();

    // Second touch — usageCount=2, confidence stays at 1.0 (capped)
    runbookMatch(PROJECT_ID, "redis OOM", { touch: true }, root);
    const after2 = runbookGet(PROJECT_ID, id, root)!;
    expect(after2.usageCount).toBe(2);
    expect(after2.confidence).toBe(1.0);
  });

  test("TC-8.5: upsert — same pattern twice → merged steps, max confidence, same id", () => {
    const id1 = runbookAdd(
      PROJECT_ID,
      "k8s pod crashloop",
      ["check logs", "kubectl describe pod"],
      { confidence: 0.5 },
      root,
    );
    const id2 = runbookAdd(
      PROJECT_ID,
      "k8s pod crashloop",
      ["kubectl describe pod", "increase memory limit"],
      { confidence: 0.85 },
      root,
    );

    expect(id2).toBe(id1);

    const rb = runbookGet(PROJECT_ID, id1, root)!;
    expect(rb.confidence).toBeCloseTo(0.85);
    // Merged + deduped, original order preserved
    expect(rb.steps).toEqual([
      "check logs",
      "kubectl describe pod",
      "increase memory limit",
    ]);

    // Only one file on disk
    const files = readdirSync(getRunbooksDir(PROJECT_ID, root));
    expect(files.length).toBe(1);
  });

  test("TC-8.6: minScore filter excludes low-score matches", () => {
    runbookAdd(
      PROJECT_ID,
      "completely unrelated topic xyzzy",
      ["do something"],
      { confidence: 0.1 },
      root,
    );

    const matches = runbookMatch(
      PROJECT_ID,
      "API rate limit exceeded",
      { minScore: 0.9, touch: false },
      root,
    );
    expect(matches.length).toBe(0);
  });

  test("TC-8.7: sourceIncidents linking preserved across upsert", () => {
    const id = runbookAdd(
      PROJECT_ID,
      "kafka consumer lag",
      ["scale consumer"],
      { sourceIncidentId: "inc-20260101-120000-aaaaaaaa", confidence: 0.5 },
      root,
    );
    const id2 = runbookAdd(
      PROJECT_ID,
      "kafka consumer lag",
      ["increase partitions"],
      {
        sourceIncidents: [
          "inc-20260102-120000-bbbbbbbb",
          "inc-20260101-120000-aaaaaaaa", // duplicate, should not duplicate
        ],
      },
      root,
    );
    expect(id2).toBe(id);

    const rb = runbookGet(PROJECT_ID, id, root)!;
    expect(rb.sourceIncidents).toEqual([
      "inc-20260101-120000-aaaaaaaa",
      "inc-20260102-120000-bbbbbbbb",
    ]);
  });

  test("TC-8.8: confidence validation (0 ≤ c ≤ 1) — invalid throws", () => {
    expect(() =>
      runbookAdd(PROJECT_ID, "p1", ["s1"], { confidence: 1.5 }, root),
    ).toThrow(/confidence/);
    expect(() =>
      runbookAdd(PROJECT_ID, "p2", ["s1"], { confidence: -0.1 }, root),
    ).toThrow(/confidence/);
    expect(() =>
      runbookAdd(PROJECT_ID, "p3", ["s1"], { confidence: NaN }, root),
    ).toThrow(/confidence/);
  });

  test("TC-8.9: invalid regex pattern → fallback to similarity (no crash)", () => {
    // Pattern includes regex meta but is not a valid regex (unclosed bracket).
    runbookAdd(
      PROJECT_ID,
      "memory leak [unclosed",
      ["heap dump", "restart"],
      { confidence: 0.5 },
      root,
    );

    const matches = runbookMatch(
      PROJECT_ID,
      "memory leak [unclosed",
      { touch: false },
      root,
    );
    expect(matches.length).toBe(1);
    // Falls back to similarity → still high since strings are identical post-normalize.
    expect(matches[0]!.similarity).toBeGreaterThan(0.9);
    expect(matches[0]!.isRegexMatch).toBe(false);
  });

  test("TC-8.10: runbookList returns all entries", () => {
    runbookAdd(PROJECT_ID, "pattern A", ["s1"], { confidence: 0.5 }, root);
    runbookAdd(PROJECT_ID, "pattern B", ["s2"], { confidence: 0.6 }, root);
    runbookAdd(PROJECT_ID, "pattern C", ["s3"], { confidence: 0.7 }, root);

    const list = runbookList(PROJECT_ID, root);
    expect(list.length).toBe(3);
    const patterns = list.map((r) => r.pattern).sort();
    expect(patterns).toEqual(["pattern A", "pattern B", "pattern C"]);
  });
});
