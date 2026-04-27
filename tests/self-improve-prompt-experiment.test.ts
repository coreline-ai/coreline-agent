/** Tests for prompt-experiment — register, pick, record, list, delete. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteExperiment,
  getExperiment,
  listExperiments,
  pickVariant,
  recordExperimentUse,
  registerExperiment,
} from "../src/agent/self-improve/prompt-experiment.js";
import { readEvidence } from "../src/agent/self-improve/evidence.js";

let tempRoot: string;
const PROJECT_ID = "proj-exp-test";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "exp-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("prompt-experiment", () => {
  test("TC-12.1: round-robin over 100 picks yields even split", () => {
    registerExperiment({
      name: "sys-ab",
      variants: [
        { id: "A", content: "variant A" },
        { id: "B", content: "variant B" },
      ],
      rootDir: tempRoot,
    });

    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 100; i++) {
      const picked = pickVariant({ name: "sys-ab", rootDir: tempRoot });
      expect(picked).not.toBeNull();
      counts[picked!.id] = (counts[picked!.id] ?? 0) + 1;
    }
    expect(counts.A).toBe(50);
    expect(counts.B).toBe(50);

    const experiment = getExperiment("sys-ab", tempRoot);
    expect(experiment).not.toBeNull();
    expect(experiment!.runs).toBe(100);
    expect(experiment!.runsByVariant.A).toBe(50);
    expect(experiment!.runsByVariant.B).toBe(50);
  });

  test("TC-12.2: recordExperimentUse aggregates per variantId", () => {
    registerExperiment({
      name: "sys-ab",
      variants: [
        { id: "A", content: "a" },
        { id: "B", content: "b" },
      ],
      rootDir: tempRoot,
    });

    const calls: Array<{ variantId: string; success: boolean }> = [
      { variantId: "A", success: true },
      { variantId: "A", success: true },
      { variantId: "A", success: false },
      { variantId: "B", success: true },
      { variantId: "B", success: false },
    ];
    for (const [i, call] of calls.entries()) {
      recordExperimentUse({
        projectId: PROJECT_ID,
        experimentName: "sys-ab",
        variantId: call.variantId,
        sessionId: `s-${i}`,
        outcome: { success: call.success, accuracy: call.success ? 100 : 0 },
        rootDir: tempRoot,
      });
    }

    const records = readEvidence(
      PROJECT_ID,
      "prompt",
      "sys-ab",
      {},
      tempRoot,
    );
    expect(records.length).toBe(5);

    // Iteration numbers should be 1..5 in append order.
    expect(records.map((r) => r.iteration)).toEqual([1, 2, 3, 4, 5]);

    // Aggregation by variantId.
    const byVariant: Record<string, { total: number; passed: number }> = {};
    for (const r of records) {
      const vid = (r.metadata?.variantId as string) ?? "_unknown";
      if (!byVariant[vid]) byVariant[vid] = { total: 0, passed: 0 };
      byVariant[vid].total += 1;
      if (r.outcome.success) byVariant[vid].passed += 1;
    }
    expect(byVariant.A).toEqual({ total: 3, passed: 2 });
    expect(byVariant.B).toEqual({ total: 2, passed: 1 });
  });

  test("TC-12.3: listExperiments + deleteExperiment", () => {
    registerExperiment({
      name: "exp-one",
      variants: [{ id: "x", content: "x" }],
      rootDir: tempRoot,
    });
    registerExperiment({
      name: "exp-two",
      variants: [{ id: "y", content: "y" }],
      rootDir: tempRoot,
    });

    const all = listExperiments(tempRoot);
    expect(all.map((e) => e.name).sort()).toEqual(["exp-one", "exp-two"]);

    const removed = deleteExperiment("exp-one", tempRoot);
    expect(removed).toBe(true);

    const remaining = listExperiments(tempRoot);
    expect(remaining.map((e) => e.name)).toEqual(["exp-two"]);

    // Deleting an already-missing experiment returns false.
    expect(deleteExperiment("exp-one", tempRoot)).toBe(false);
  });

  test("TC-12.4: pickVariant on unregistered experiment returns null", () => {
    const picked = pickVariant({ name: "does-not-exist", rootDir: tempRoot });
    expect(picked).toBeNull();
  });

  test("TC-12.E1: corrupt experiment JSON is skipped; re-register overwrites", () => {
    const dir = join(tempRoot, "experiments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{not valid json", "utf8");

    // Register a sibling so list has something real.
    registerExperiment({
      name: "good",
      variants: [{ id: "a", content: "a" }],
      rootDir: tempRoot,
    });

    const all = listExperiments(tempRoot);
    expect(all.map((e) => e.name)).toEqual(["good"]);

    // Overwrite "bad" by registering with that name — should succeed.
    const re = registerExperiment({
      name: "bad",
      variants: [{ id: "v1", content: "v1" }],
      rootDir: tempRoot,
    });
    expect(re.name).toBe("bad");
    expect(re.runs).toBe(0);

    const loaded = getExperiment("bad", tempRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.variants[0]!.id).toBe("v1");

    const picked = pickVariant({ name: "bad", rootDir: tempRoot });
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe("v1");
  });
});
