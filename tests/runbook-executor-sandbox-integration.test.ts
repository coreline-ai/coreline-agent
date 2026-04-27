/**
 * Wave 10 P2 — F5: Runbook executor sandbox-integration tests.
 *
 * Verifies that `runbookApply` honours the opt-in `RUNBOOK_SANDBOX_ENABLE`
 * flag, falls back to the existing `manual_needed` MVP behaviour when the
 * flag is unset, and short-circuits the rest of the runbook on the first
 * failing step.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runbookAdd } from "../src/agent/runbook/runbook-store.js";
import { runbookApply } from "../src/agent/runbook/runbook-executor.js";

const PROJECT_ID = "p-runbook-sandbox-int-test";

let root: string;
const ORIGINAL_FLAG = process.env.RUNBOOK_SANDBOX_ENABLE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runbook-sandbox-int-"));
  delete process.env.RUNBOOK_SANDBOX_ENABLE;
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.RUNBOOK_SANDBOX_ENABLE;
  } else {
    process.env.RUNBOOK_SANDBOX_ENABLE = ORIGINAL_FLAG;
  }
});

describe("Runbook executor — sandbox integration (Wave 10 P2 F5)", () => {
  test("flag=true + dryRun:false + safe runbook → real success", async () => {
    process.env.RUNBOOK_SANDBOX_ENABLE = "true";

    const id = runbookAdd(
      PROJECT_ID,
      "echo flow",
      ["echo step-one", "echo step-two"],
      { confidence: 0.7 },
      root,
    );

    const res = await runbookApply(PROJECT_ID, id, { dryRun: false }, root);
    expect(res.dryRun).toBe(false);
    expect(res.stepResults.length).toBe(2);
    for (const r of res.stepResults) {
      expect(r.status).toBe("success");
    }
    expect(res.success).toBe(true);
    expect(res.stepsExecuted).toBe(2);
  });

  test("flag=true + dryRun:true → still simulated (dry-run wins)", async () => {
    process.env.RUNBOOK_SANDBOX_ENABLE = "true";

    const id = runbookAdd(
      PROJECT_ID,
      "echo flow dry",
      ["echo a", "echo b"],
      { confidence: 0.5 },
      root,
    );

    const res = await runbookApply(PROJECT_ID, id, { dryRun: true }, root);
    expect(res.dryRun).toBe(true);
    for (const r of res.stepResults) {
      expect(r.status).toBe("simulated");
    }
  });

  test("flag unset (default) + dryRun:false → manual_needed (existing MVP)", async () => {
    delete process.env.RUNBOOK_SANDBOX_ENABLE;

    const id = runbookAdd(
      PROJECT_ID,
      "manual mvp",
      ["echo x", "echo y"],
      { confidence: 0.5 },
      root,
    );

    const res = await runbookApply(PROJECT_ID, id, { dryRun: false }, root);
    expect(res.dryRun).toBe(false);
    expect(res.stepResults.length).toBe(2);
    for (const r of res.stepResults) {
      expect(r.status).toBe("manual_needed");
      expect(r.output).toContain("RUNBOOK_SANDBOX_ENABLE");
    }
    expect(res.stepsExecuted).toBe(0);
  });

  test("flag=true + first step fails → subsequent steps skipped", async () => {
    process.env.RUNBOOK_SANDBOX_ENABLE = "true";

    // First step is denied by the gate (`rm -rf /tmp/...` is on the hard
    // block list); second step would succeed if reached.
    const id = runbookAdd(
      PROJECT_ID,
      "stop on first failure",
      ["rm -rf /", "echo never-reached"],
      { confidence: 0.5 },
      root,
    );

    const res = await runbookApply(PROJECT_ID, id, { dryRun: false }, root);
    expect(res.stepResults.length).toBe(1);
    expect(res.stepResults[0]!.status).toBe("permission_denied");
    expect(res.success).toBe(false);
  });

  test("flag=true + verification step runs after successful steps", async () => {
    process.env.RUNBOOK_SANDBOX_ENABLE = "true";

    const id = runbookAdd(
      PROJECT_ID,
      "verify after run",
      ["echo ok"],
      { confidence: 0.6, verification: "echo verified" },
      root,
    );

    const res = await runbookApply(PROJECT_ID, id, { dryRun: false }, root);
    expect(res.stepResults.length).toBe(2);
    expect(res.stepResults[0]!.status).toBe("success");
    expect(res.stepResults[1]!.status).toBe("success");
    expect(res.verificationPassed).toBe(true);
  });
});
