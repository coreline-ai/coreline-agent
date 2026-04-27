/**
 * Phase 7 (Wave 9) — Decision Store tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decisionGet,
  decisionRecord,
  decisionSearch,
  decisionUpdate,
} from "../src/agent/decision/decision-store.js";
import { incidentRecord, incidentGet, incidentUpdate } from "../src/agent/incident/incident-store.js";
import { getDecisionsDir } from "../src/config/paths.js";

const PROJECT_ID = "p-decision-test";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "decision-store-"));
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

describe("Decision Store — Phase 7 / Wave 9", () => {
  test("TC-7.1: decisionRecord creates file with What/Why/How sections", () => {
    const id = decisionRecord(
      PROJECT_ID,
      "Use bun for runtime",
      "Faster startup than node, native TS",
      "Set engines.bun in package.json",
      undefined,
      root,
    );

    expect(id).toMatch(/^dec-\d{8}-/);
    const dir = getDecisionsDir(PROJECT_ID, root);
    const files = readdirSync(dir);
    expect(files).toContain(`${id}.md`);

    const content = readFileSync(join(dir, `${id}.md`), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain("type: decision");
    expect(content).toContain("status: accepted");
    expect(content).toContain("# Decision: Use bun for runtime");
    expect(content).toContain("## What");
    expect(content).toContain("Use bun for runtime");
    expect(content).toContain("## Why");
    expect(content).toContain("Faster startup than node");
    expect(content).toContain("## How");
    expect(content).toContain("engines.bun");
    expect(content).toContain("## Outcome");
    expect(content).toContain("(pending)");
    expect(content).toContain("## Linked Incidents");
  });

  test("TC-7.2: decisionUpdate appendWhy appends with timestamp", () => {
    const id = decisionRecord(
      PROJECT_ID,
      "Adopt strict TS",
      "Catch type errors early",
      "tsconfig strict:true",
      undefined,
      root,
    );

    const updated = decisionUpdate(
      PROJECT_ID,
      id,
      { appendWhy: "Reduces production bugs by 30%" },
      root,
    );

    expect(updated.why).toContain("Catch type errors early");
    expect(updated.why).toContain("Reduces production bugs by 30%");

    const dir = getDecisionsDir(PROJECT_ID, root);
    const content = readFileSync(join(dir, `${id}.md`), "utf-8");
    expect(content).toMatch(/- \[\d{4}-\d{2}-\d{2}T.*Z\] Reduces production bugs by 30%/);
  });

  test("TC-7.3: linkedIncidents → incident file gets `## Related: decision: dec-xxx`", () => {
    const incidentId = incidentRecord(
      PROJECT_ID,
      "Memory leak in worker",
      ["RSS grows unbounded"],
      undefined,
      root,
    );

    const decisionId = decisionRecord(
      PROJECT_ID,
      "Add memory limit guard",
      "Prevent OOM",
      "Set --max-old-space-size",
      { linkedIncidents: [incidentId] },
      root,
    );

    const inc = incidentGet(PROJECT_ID, incidentId, root);
    expect(inc).not.toBeNull();
    expect(inc!.related).toContain(`decision: ${decisionId}`);
  });

  test("TC-7.4: status:accepted → tier:core; status:superseded → tier:archival", () => {
    const acceptedId = decisionRecord(
      PROJECT_ID,
      "Accepted decision",
      "Why accepted",
      "How accepted",
      { status: "accepted" },
      root,
    );
    const accepted = decisionGet(PROJECT_ID, acceptedId, root);
    expect(accepted!.tier).toBe("core");

    const supersededId = decisionRecord(
      PROJECT_ID,
      "Old approach",
      "Why old",
      "How old",
      { status: "superseded" },
      root,
    );
    const superseded = decisionGet(PROJECT_ID, supersededId, root);
    expect(superseded!.tier).toBe("archival");

    const rejectedId = decisionRecord(
      PROJECT_ID,
      "Rejected idea",
      "Why rejected",
      "How rejected",
      { status: "rejected" },
      root,
    );
    expect(decisionGet(PROJECT_ID, rejectedId, root)!.tier).toBe("archival");

    const proposedId = decisionRecord(
      PROJECT_ID,
      "Proposed change",
      "Why proposed",
      "How proposed",
      { status: "proposed" },
      root,
    );
    expect(decisionGet(PROJECT_ID, proposedId, root)!.tier).toBe("core");
  });

  test("TC-7.5: decisionSearch by status, tag, linkedIncident", () => {
    const incId = incidentRecord(PROJECT_ID, "Inc A", ["sym"], undefined, root);

    decisionRecord(
      PROJECT_ID,
      "Decision Alpha",
      "why alpha",
      "how alpha",
      { status: "accepted", tags: ["arch", "infra"], linkedIncidents: [incId] },
      root,
    );
    decisionRecord(
      PROJECT_ID,
      "Decision Beta",
      "why beta",
      "how beta",
      { status: "proposed", tags: ["infra"] },
      root,
    );
    decisionRecord(
      PROJECT_ID,
      "Decision Gamma",
      "why gamma",
      "how gamma",
      { status: "accepted", tags: ["arch"] },
      root,
    );

    const accepted = decisionSearch(PROJECT_ID, { status: "accepted" }, root);
    expect(accepted.length).toBe(2);

    const archTagged = decisionSearch(PROJECT_ID, { tag: "arch" }, root);
    expect(archTagged.length).toBe(2);

    const linked = decisionSearch(PROJECT_ID, { linkedIncident: incId }, root);
    expect(linked.length).toBe(1);
    expect(linked[0]!.title).toBe("Decision Alpha");
  });

  test("TC-7.6: decisionGet non-existent → null", () => {
    const result = decisionGet(PROJECT_ID, "dec-99999999-nope", root);
    expect(result).toBeNull();
  });

  test("TC-7.7: D19 — linkedIncident that doesn't exist → console.warn but continue", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const id = decisionRecord(
        PROJECT_ID,
        "Decision with bad link",
        "why",
        "how",
        { linkedIncidents: ["inc-00000000-000000-deadbeef"] },
        root,
      );
      expect(id).toMatch(/^dec-/);
      expect(warnings.some((w) => w.includes("inc-00000000-000000-deadbeef"))).toBe(true);

      // Decision still saved
      const dec = decisionGet(PROJECT_ID, id, root);
      expect(dec).not.toBeNull();
      expect(dec!.linkedIncidents).toContain("inc-00000000-000000-deadbeef");
    } finally {
      console.warn = orig;
    }
  });

  test("TC-7.8: D19 — archived (resolved) incident accepts decision link", () => {
    const incId = incidentRecord(
      PROJECT_ID,
      "Old fixed incident",
      ["was broken"],
      { resolution: "patched in v2" },
      root,
    );
    const inc = incidentGet(PROJECT_ID, incId, root);
    expect(inc!.status).toBe("resolved");
    expect(inc!.tier).toBe("archival");

    const decId = decisionRecord(
      PROJECT_ID,
      "Reference to old fix",
      "Reaffirm v2 patch",
      "Document in runbook",
      { linkedIncidents: [incId] },
      root,
    );

    const inc2 = incidentGet(PROJECT_ID, incId, root);
    expect(inc2!.related).toContain(`decision: ${decId}`);
  });

  test("TC-7.9: bidirectional roundtrip — read decision after linking, see both ends", () => {
    const incId = incidentRecord(
      PROJECT_ID,
      "Latency spike",
      ["P99 > 2s"],
      undefined,
      root,
    );
    const decId = decisionRecord(
      PROJECT_ID,
      "Add CDN caching",
      "Reduce P99",
      "Cloudflare in front of API",
      { linkedIncidents: [incId] },
      root,
    );

    const dec = decisionGet(PROJECT_ID, decId, root);
    expect(dec!.linkedIncidents).toContain(incId);

    const inc = incidentGet(PROJECT_ID, incId, root);
    expect(inc!.related).toContain(`decision: ${decId}`);
  });

  test("TC-7.10: id format dec-YYYYMMDD-{slug} — slug truncated/sanitized", () => {
    const longText =
      "This is a very long decision title with special chars !@#$%^& and many words";
    const id = decisionRecord(PROJECT_ID, longText, "why", "how", undefined, root);

    expect(id).toMatch(/^dec-\d{8}-/);
    // Extract slug (after dec-YYYYMMDD-)
    const slug = id.replace(/^dec-\d{8}-/, "");
    // Slug should be from first 30 chars lowercased + sanitized; should not contain special chars
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug).not.toMatch(/[!@#$%^&]/);
    // Should contain only word chars and hyphens
    expect(slug).toMatch(/^[\w-]+$/);
  });
});
