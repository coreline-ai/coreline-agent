/**
 * Phase 7 (Wave 9) — evidence_first tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceFirst } from "../src/agent/decision/evidence-first.js";
import { decisionRecord } from "../src/agent/decision/decision-store.js";
import { incidentRecord } from "../src/agent/incident/incident-store.js";
import { indexSession } from "../src/memory/session-recall.js";
import type { ChatMessage } from "../src/agent/types.js";

const PROJECT_ID = "p-evidence-first";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "evidence-first-"));
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

function seed(): void {
  const messages: ChatMessage[] = [
    { role: "user", content: "How do I optimize database query performance?" },
    {
      role: "assistant",
      content: "Use indexes on hot columns and analyze EXPLAIN output for database query plans.",
    },
  ];
  indexSession({
    projectId: PROJECT_ID,
    sessionId: "sess-1",
    messages,
    rootDir: root,
  });

  incidentRecord(
    PROJECT_ID,
    "Database query timeout",
    ["query took 30s on users table"],
    { severity: "high" },
    root,
  );

  decisionRecord(
    PROJECT_ID,
    "Add database query index on users.email",
    "Speed up login lookups",
    "CREATE INDEX",
    { status: "accepted" },
    root,
  );
}

describe("evidenceFirst — Phase 7 / Wave 9", () => {
  test("TC-7.11: evidenceFirst returns 3 source domains in counts", async () => {
    seed();
    const r = await evidenceFirst(PROJECT_ID, "database query", { rootDir: root });
    expect(r.counts).toEqual({
      memory: r.counts.memory,
      incident: r.counts.incident,
      decision: r.counts.decision,
    });
    expect(r.counts.memory).toBeGreaterThanOrEqual(1);
    expect(r.counts.incident).toBeGreaterThanOrEqual(1);
    expect(r.counts.decision).toBeGreaterThanOrEqual(1);
    expect(r.query).toBe("database query");
  });

  test("TC-7.12: limit caps results", async () => {
    seed();
    // Add many decisions
    for (let i = 0; i < 10; i++) {
      decisionRecord(
        PROJECT_ID,
        `Database scaling decision number ${i}`,
        "why",
        "how",
        undefined,
        root,
      );
    }
    const r = await evidenceFirst(PROJECT_ID, "database", { limit: 3, rootDir: root });
    expect(r.results.length).toBeLessThanOrEqual(3);
  });

  test("TC-7.13: results sorted by score desc", async () => {
    seed();
    const r = await evidenceFirst(PROJECT_ID, "database query", { rootDir: root });
    for (let i = 1; i < r.results.length; i++) {
      expect(r.results[i - 1]!.score).toBeGreaterThanOrEqual(r.results[i]!.score);
    }
  });

  test("TC-7.14: empty domains → counts all 0, results []", async () => {
    const r = await evidenceFirst(PROJECT_ID, "nothing matches xyz123", {
      rootDir: root,
    });
    expect(r.counts.memory).toBe(0);
    expect(r.counts.incident).toBe(0);
    expect(r.counts.decision).toBe(0);
    expect(r.results).toEqual([]);
  });

  test("TC-7.15: timing — elapsedMs > 0", async () => {
    seed();
    const r = await evidenceFirst(PROJECT_ID, "database", { rootDir: root });
    expect(r.elapsedMs).toBeGreaterThan(0);
  });
});
