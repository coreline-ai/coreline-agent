/**
 * Wave 10 P0 / F1 — TUI handler tests.
 *
 * Covers the 9 REPL slash-command handlers added in Wave 10 Phase 0:
 * fact, memory-decay, link, search-precise, incident, decision,
 * evidence-first, runbook, rca.
 *
 * Each handler is invoked directly (no React render) with fixtures populated
 * via the underlying backend modules; output is compared as plain strings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { factAdd } from "../src/memory/facts.js";
import { incidentRecord } from "../src/agent/incident/incident-store.js";
import { decisionRecord } from "../src/agent/decision/decision-store.js";
import { runbookAdd } from "../src/agent/runbook/runbook-store.js";
import { handleFactCommand } from "../src/tui/handlers/fact-handler.js";
import { handleDecayCommand } from "../src/tui/handlers/decay-handler.js";
import { handleLinkCommand } from "../src/tui/handlers/link-handler.js";
import { handleSearchPreciseCommand } from "../src/tui/handlers/search-precise-handler.js";
import { handleIncidentCommand } from "../src/tui/handlers/incident-handler.js";
import { handleDecisionCommand } from "../src/tui/handlers/decision-handler.js";
import { handleEvidenceFirstCommand } from "../src/tui/handlers/evidence-first-handler.js";
import { handleRunbookCommand } from "../src/tui/handlers/runbook-handler.js";
import { handleRcaCommand } from "../src/tui/handlers/rca-handler.js";
import type { HandlerContext } from "../src/tui/handlers/types.js";

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

interface Harness {
  root: string;
  cleanup: () => void;
  context: HandlerContext;
  projectMemory: ProjectMemory;
}

function makeHarness(prefix: string): Harness {
  const root = mkTmp(prefix);
  const cwd = join(root, "cwd");
  const projectMemory = new ProjectMemory(cwd, { rootDir: root });
  // Force ensureStorage by writing a no-op
  projectMemory.loadAll();
  const context: HandlerContext = {
    projectMemory,
    projectId: projectMemory.projectId,
    rootDir: root,
  };
  return {
    root,
    projectMemory,
    context,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("TUI handlers — Wave 10 F1 (Wave 7/8/9 actions)", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness("tui-handlers");
  });

  afterEach(() => {
    harness.cleanup();
  });

  // -------------------------------------------------------------------------
  // fact handler
  // -------------------------------------------------------------------------

  describe("handleFactCommand", () => {
    test("add → success message includes file path", async () => {
      const out = await handleFactCommand(
        { command: "add", entity: "Simon", key: "role", value: "CEO", validFrom: "2020-03-01" },
        harness.context,
      );
      expect(out).toContain("Fact added: Simon.role = CEO");
      expect(out).toContain("File:");
    });

    test("at → returns matching fact in markdown table", async () => {
      factAdd(harness.projectMemory, "Simon", "role", "CTO", {
        validFrom: "2018-01-01",
        validTo: "2020-02-29",
        recordedAt: "2024-05-10T14:22",
      });
      const out = await handleFactCommand(
        { command: "at", entity: "Simon", key: "role", asOf: "2019-06-01" },
        harness.context,
      );
      expect(out).toContain("| key | value | validFrom | validTo | recordedAt |");
      expect(out).toContain("| role | CTO | 2018-01-01 | 2020-02-29 | 2024-05-10T14:22 |");
    });

    test("history → empty entity returns (no results)", async () => {
      const out = await handleFactCommand(
        { command: "history", entity: "Ghost" },
        harness.context,
      );
      expect(out).toBe("(no results)");
    });

    test("missing arg → Error message", async () => {
      const out = await handleFactCommand({ command: "add" }, harness.context);
      expect(out).toContain("Error:");
    });

    test("keys → list keys after add", async () => {
      factAdd(harness.projectMemory, "Bob", "role", "engineer");
      factAdd(harness.projectMemory, "Bob", "team", "platform");
      const out = await handleFactCommand(
        { command: "keys", entity: "Bob" },
        harness.context,
      );
      expect(out).toContain("- role");
      expect(out).toContain("- team");
    });
  });

  // -------------------------------------------------------------------------
  // decay handler
  // -------------------------------------------------------------------------

  describe("handleDecayCommand", () => {
    test("apply on missing entry → Error", async () => {
      const out = await handleDecayCommand(
        { command: "apply", name: "ghost-entry" },
        harness.context,
      );
      expect(out).toContain("Error: memory entry not found");
    });

    test("list with no decayed entries → (no results)", async () => {
      const out = await handleDecayCommand({ command: "list" }, harness.context);
      expect(out).toBe("(no results)");
    });

    test("isTombstoned → live for unknown name", async () => {
      const out = await handleDecayCommand(
        { command: "isTombstoned", name: "nope" },
        harness.context,
      );
      expect(out).toBe("nope: live");
    });
  });

  // -------------------------------------------------------------------------
  // link handler
  // -------------------------------------------------------------------------

  describe("handleLinkCommand", () => {
    test("scan on empty memory → 0 files", async () => {
      const out = await handleLinkCommand({ command: "scan" }, harness.context);
      expect(out).toContain("filesScanned: 0");
      expect(out).toContain("entitiesLinked: 0");
    });

    test("orphans with empty memory → no results", async () => {
      const out = await handleLinkCommand({ command: "orphans" }, harness.context);
      expect(out).toContain("(no results)");
    });

    test("forward without source → Error", async () => {
      const out = await handleLinkCommand({ command: "forward" }, harness.context);
      expect(out).toContain("Error:");
    });
  });

  // -------------------------------------------------------------------------
  // search-precise handler
  // -------------------------------------------------------------------------

  describe("handleSearchPreciseCommand", () => {
    test("empty query → Error", async () => {
      const out = await handleSearchPreciseCommand({ query: "" }, harness.context);
      expect(out).toContain("Error:");
    });

    test("no matching entries → (no results)", async () => {
      const out = await handleSearchPreciseCommand(
        { query: "nonexistent-token-xyz" },
        harness.context,
      );
      expect(out).toContain("(no results)");
    });

    test("hit returns markdown table", async () => {
      harness.projectMemory.writeEntry({
        name: "design-notes",
        description: "Architecture decisions",
        type: "reference",
        body: "We chose pgsql for the warehouse",
        filePath: "",
      });
      const out = await handleSearchPreciseCommand(
        { query: "pgsql" },
        harness.context,
      );
      expect(out).toContain("| name | type | tier | description |");
      expect(out).toContain("design-notes");
    });
  });

  // -------------------------------------------------------------------------
  // incident handler
  // -------------------------------------------------------------------------

  describe("handleIncidentCommand", () => {
    test("show non-existent → Error", async () => {
      const out = await handleIncidentCommand(
        { command: "show", id: "inc-missing" },
        harness.context,
      );
      expect(out).toContain("Error: incident not found");
    });

    test("list/show happy path", async () => {
      const id = incidentRecord(
        harness.context.projectId,
        "API timeout",
        ["response delay", "ECONNRESET"],
        { severity: "high", hypothesis: ["pool exhaustion"] },
        harness.root,
      );

      const list = await handleIncidentCommand({ command: "list" }, harness.context);
      expect(list).toContain("| id | severity | status | title | detectedAt |");
      expect(list).toContain(id);
      expect(list).toContain("API timeout");

      const show = await handleIncidentCommand({ command: "show", id }, harness.context);
      expect(show).toContain(`## Incident ${id}`);
      expect(show).toContain("- title: API timeout");
      expect(show).toContain("- severity: high");
      expect(show).toContain("### Symptoms");
      expect(show).toContain("- response delay");
      expect(show).toContain("### Hypotheses");
      expect(show).toContain("[testing");
      expect(show).toContain("### Resolution");
    });

    test("resolve marks incident resolved", async () => {
      const id = incidentRecord(
        harness.context.projectId,
        "DB latency",
        ["slow queries"],
        { severity: "medium" },
        harness.root,
      );
      const out = await handleIncidentCommand(
        { command: "resolve", id, resolution: "Added index" },
        harness.context,
      );
      expect(out).toContain(`Incident ${id} resolved`);
      expect(out).toContain("- status: resolved");
      expect(out).toContain("Added index");
    });
  });

  // -------------------------------------------------------------------------
  // decision handler
  // -------------------------------------------------------------------------

  describe("handleDecisionCommand", () => {
    test("show non-existent → Error", async () => {
      const out = await handleDecisionCommand(
        { command: "show", id: "dec-missing" },
        harness.context,
      );
      expect(out).toContain("Error: decision not found");
    });

    test("record + list + show", async () => {
      const recOut = await handleDecisionCommand(
        {
          command: "record",
          what: "Adopt Postgres",
          why: "Need ACID",
          how: "Migrate from sqlite",
          tags: ["arch"],
        },
        harness.context,
      );
      expect(recOut).toContain("Decision recorded:");
      expect(recOut).toContain("### What");
      expect(recOut).toContain("Adopt Postgres");

      const list = await handleDecisionCommand({ command: "list" }, harness.context);
      expect(list).toContain("| id | status | title | decidedAt |");
      expect(list).toContain("Adopt Postgres");
    });

    test("update outcome appends", async () => {
      const id = decisionRecord(
        harness.context.projectId,
        "Use TypeScript strict mode",
        "Catch bugs early",
        "Set strict: true",
        undefined,
        harness.root,
      );
      const out = await handleDecisionCommand(
        { command: "update", id, outcome: "Found 50 issues" },
        harness.context,
      );
      expect(out).toContain(`Decision ${id} updated`);
      expect(out).toContain("Found 50 issues");
    });
  });

  // -------------------------------------------------------------------------
  // evidence-first handler
  // -------------------------------------------------------------------------

  describe("handleEvidenceFirstCommand", () => {
    test("empty query → Error", async () => {
      const out = await handleEvidenceFirstCommand({ query: "" }, harness.context);
      expect(out).toContain("Error:");
    });

    test("no hits → (no results)", async () => {
      const out = await handleEvidenceFirstCommand(
        { query: "absolutely-nothing-matches" },
        harness.context,
      );
      expect(out).toContain("(no results)");
    });

    test("includes hits across domains", async () => {
      incidentRecord(
        harness.context.projectId,
        "cache miss storm",
        ["high latency on cache miss"],
        { severity: "high" },
        harness.root,
      );
      decisionRecord(
        harness.context.projectId,
        "Add cache",
        "Reduce DB load",
        "Use redis",
        undefined,
        harness.root,
      );
      const out = await handleEvidenceFirstCommand(
        { query: "cache" },
        harness.context,
      );
      expect(out).toContain("## Evidence-first: cache");
      expect(out).toContain("| source | id/session | title/summary | score |");
    });
  });

  // -------------------------------------------------------------------------
  // runbook handler
  // -------------------------------------------------------------------------

  describe("handleRunbookCommand", () => {
    test("show non-existent → Error", async () => {
      const out = await handleRunbookCommand(
        { command: "show", id: "rb-missing" },
        harness.context,
      );
      expect(out).toContain("Error: runbook not found");
    });

    test("record/list/show/match/apply happy path", async () => {
      const recordOut = await handleRunbookCommand(
        {
          command: "record",
          pattern: "connection pool exhaustion",
          steps: ["Check pool size", "Increase max connections", "Restart workers"],
        },
        harness.context,
      );
      expect(recordOut).toContain("Runbook recorded:");
      expect(recordOut).toContain("### Steps");
      expect(recordOut).toContain("1. Check pool size");

      const list = await handleRunbookCommand({ command: "list" }, harness.context);
      expect(list).toContain("| id | confidence | usage | pattern | tags |");
      expect(list).toContain("connection pool exhaustion");

      const match = await handleRunbookCommand(
        { command: "match", symptom: "connection pool exhaustion" },
        harness.context,
      );
      expect(match).toContain("## Runbook match: connection pool exhaustion");
      expect(match).toContain("connection pool exhaustion");

      // Find the recorded id from runbook list — re-record gives same id by upsert
      const id = runbookAdd(
        harness.context.projectId,
        "connection pool exhaustion",
        ["Check pool size"],
        undefined,
        harness.root,
      );
      const apply = await handleRunbookCommand(
        { command: "apply", id, dryRun: true },
        harness.context,
      );
      expect(apply).toContain(`## Runbook apply — ${id}`);
      expect(apply).toContain("- dryRun: true");
      expect(apply).toContain("simulated");
    });
  });

  // -------------------------------------------------------------------------
  // rca handler
  // -------------------------------------------------------------------------

  describe("handleRcaCommand", () => {
    test("missing incident → Error", async () => {
      const out = await handleRcaCommand({ incidentId: "inc-missing" }, harness.context);
      expect(out).toContain("Error: Incident not found");
    });

    test("happy path → markdown report sections", async () => {
      const id = incidentRecord(
        harness.context.projectId,
        "DB connection failures",
        ["pool exhausted", "ECONNREFUSED"],
        {
          severity: "high",
          hypothesis: ["pool exhaustion", "DNS issue"],
        },
        harness.root,
      );
      runbookAdd(
        harness.context.projectId,
        "pool exhausted",
        ["Increase pool size"],
        undefined,
        harness.root,
      );
      const out = await handleRcaCommand({ incidentId: id }, harness.context);
      expect(out).toContain(`## RCA Report — ${id} (heuristic)`);
      expect(out).toContain("### Hypotheses (sorted by score)");
      expect(out).toContain("### Suggested Runbooks");
      expect(out).toContain("### Related Incidents");
    });
  });
});
