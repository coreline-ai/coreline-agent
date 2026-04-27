/**
 * Wave 10 P1 R3 — store + validator integration tests.
 *
 * Verifies that store *Get / *Search / *List functions silently skip
 * records with corrupted frontmatter (warn + return null/filtered).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decisionGet,
  decisionRecord,
  decisionSearch,
} from "../src/agent/decision/decision-store.js";
import {
  incidentGet,
  incidentRecord,
  incidentSearch,
} from "../src/agent/incident/incident-store.js";
import {
  runbookAdd,
  runbookGet,
  runbookList,
} from "../src/agent/runbook/runbook-store.js";
import {
  getDecisionsDir,
  getIncidentsDir,
  getRunbooksDir,
} from "../src/config/paths.js";

const PROJECT_ID = "p-validator-integ";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "store-validator-"));
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

describe("Store + validator integration — Wave 10 P1 R3", () => {
  test("incidentGet returns valid record", () => {
    const id = incidentRecord(
      PROJECT_ID,
      "valid incident",
      ["symptom"],
      { severity: "high" },
      root,
    );
    const got = incidentGet(PROJECT_ID, id, root);
    expect(got).not.toBeNull();
    expect(got?.severity).toBe("high");
  });

  test("incidentGet returns null + warns for corrupted frontmatter", () => {
    const id = incidentRecord(
      PROJECT_ID,
      "to corrupt",
      ["symptom"],
      { severity: "high" },
      root,
    );
    const dir = getIncidentsDir(PROJECT_ID, root);
    const path = join(dir, `${id}.md`);
    const content = readFileSync(path, "utf-8");
    // Corrupt: replace severity with bogus value
    const corrupted = content.replace("severity: high", "severity: bogus");
    writeFileSync(path, corrupted, "utf-8");

    const got = incidentGet(PROJECT_ID, id, root);
    expect(got).toBeNull();
  });

  test("incidentSearch filters out invalid records", () => {
    const idGood = incidentRecord(
      PROJECT_ID,
      "good incident",
      ["sym"],
      { severity: "high" },
      root,
    );
    const idBad = incidentRecord(
      PROJECT_ID,
      "bad incident",
      ["sym"],
      { severity: "low" },
      root,
    );
    const dir = getIncidentsDir(PROJECT_ID, root);
    const badPath = join(dir, `${idBad}.md`);
    const corrupted = readFileSync(badPath, "utf-8").replace(
      "severity: low",
      "severity: bogus",
    );
    writeFileSync(badPath, corrupted, "utf-8");

    const results = incidentSearch(PROJECT_ID, undefined, root);
    expect(results.map((r) => r.id)).toContain(idGood);
    expect(results.map((r) => r.id)).not.toContain(idBad);
  });

  test("decisionGet returns null for corrupted status", () => {
    const id = decisionRecord(
      PROJECT_ID,
      "what",
      "why",
      "how",
      undefined,
      root,
    );
    const dir = getDecisionsDir(PROJECT_ID, root);
    const path = join(dir, `${id}.md`);
    const corrupted = readFileSync(path, "utf-8").replace(
      "status: accepted",
      "status: weird",
    );
    writeFileSync(path, corrupted, "utf-8");

    expect(decisionGet(PROJECT_ID, id, root)).toBeNull();
  });

  test("decisionSearch filters out invalid records", () => {
    const idGood = decisionRecord(
      PROJECT_ID,
      "valid one",
      "why a",
      "how a",
      undefined,
      root,
    );
    const idBad = decisionRecord(
      PROJECT_ID,
      "bad one different",
      "why b",
      "how b",
      undefined,
      root,
    );
    const dir = getDecisionsDir(PROJECT_ID, root);
    const badPath = join(dir, `${idBad}.md`);
    const corrupted = readFileSync(badPath, "utf-8").replace(
      "status: accepted",
      "status: bogus",
    );
    writeFileSync(badPath, corrupted, "utf-8");

    const results = decisionSearch(PROJECT_ID, undefined, root);
    expect(results.map((r) => r.id)).toContain(idGood);
    expect(results.map((r) => r.id)).not.toContain(idBad);
  });

  test("runbookGet returns null for corrupted confidence", () => {
    const id = runbookAdd(
      PROJECT_ID,
      "pool exhaustion",
      ["restart pool"],
      { confidence: 0.7 },
      root,
    );
    const dir = getRunbooksDir(PROJECT_ID, root);
    const path = join(dir, `${id}.md`);
    const corrupted = readFileSync(path, "utf-8").replace(
      "confidence: 0.7",
      "confidence: 99",
    );
    writeFileSync(path, corrupted, "utf-8");

    expect(runbookGet(PROJECT_ID, id, root)).toBeNull();
  });

  test("runbookList filters out invalid records", () => {
    const idGood = runbookAdd(
      PROJECT_ID,
      "good pattern",
      ["step"],
      { confidence: 0.5 },
      root,
    );
    const idBad = runbookAdd(
      PROJECT_ID,
      "bad pattern",
      ["step"],
      { confidence: 0.5 },
      root,
    );
    const dir = getRunbooksDir(PROJECT_ID, root);
    const badPath = join(dir, `${idBad}.md`);
    // Corrupt tier with invalid value
    const corrupted = readFileSync(badPath, "utf-8").replace(
      "tier: recall",
      "tier: weird",
    );
    writeFileSync(badPath, corrupted, "utf-8");

    const list = runbookList(PROJECT_ID, root);
    expect(list.map((r) => r.id)).toContain(idGood);
    expect(list.map((r) => r.id)).not.toContain(idBad);
    // Sanity: file still exists
    expect(readdirSync(dir)).toContain(`${idBad}.md`);
  });
});
