/**
 * Phase 7 (B3) — Memory auto-promotion tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { tierOf } from "../src/memory/tiering.js";
import {
  promoteByAccessCount,
  resetSessionCounters,
  sessionTickAndMaybePromote,
} from "../src/memory/auto-promote.js";

describe("Memory auto-promotion (Phase 7)", () => {
  let rootDir: string;
  let workspace: string;
  let projectMemory: ProjectMemory;
  let prevEnv: string | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "auto-promote-test-"));
    workspace = mkdtempSync(join(tmpdir(), "auto-promote-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Rules\nTest workspace.");
    projectMemory = new ProjectMemory(workspace, { rootDir });
    prevEnv = process.env.CORELINE_AUTO_PROMOTE;
    // Ensure a clean enabled state per-test; individual tests override as needed.
    delete process.env.CORELINE_AUTO_PROMOTE;
    resetSessionCounters();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.CORELINE_AUTO_PROMOTE;
    } else {
      process.env.CORELINE_AUTO_PROMOTE = prevEnv;
    }
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // TC-7.1: recall entry with accessCount: 3 → promoted to core.
  test("TC-7.1: recall + accessCount>=threshold → promoted to core", () => {
    projectMemory.writeEntry({
      name: "hot_note",
      description: "hot recall entry",
      type: "reference",
      body: "some body",
      filePath: "",
      tier: "recall",
      accessCount: 3,
    });

    const result = promoteByAccessCount({ projectMemory });

    expect(result.skipped).toBeUndefined();
    expect(result.promoted).toBe(1);
    expect(result.promotedNames).toEqual(["hot_note"]);
    expect(result.dryRun).toBe(false);
    expect(tierOf(projectMemory, "hot_note")).toBe("core");
  });

  // TC-7.2: recall with accessCount: 2 → stays recall.
  test("TC-7.2: recall + accessCount<threshold → stays recall", () => {
    projectMemory.writeEntry({
      name: "warm_note",
      description: "warm recall entry",
      type: "reference",
      body: "body",
      filePath: "",
      tier: "recall",
      accessCount: 2,
    });

    const result = promoteByAccessCount({ projectMemory });

    expect(result.promoted).toBe(0);
    expect(result.promotedNames).toEqual([]);
    expect(tierOf(projectMemory, "warm_note")).toBe("recall");
  });

  // TC-7.3: core entry with accessCount: 5 → stays core (no-op).
  test("TC-7.3: core entry is untouched regardless of accessCount", () => {
    projectMemory.writeEntry({
      name: "pinned_note",
      description: "already core",
      type: "project",
      body: "body",
      filePath: "",
      tier: "core",
      accessCount: 5,
    });

    const result = promoteByAccessCount({ projectMemory });

    expect(result.promoted).toBe(0);
    expect(result.promotedNames).toEqual([]);
    expect(tierOf(projectMemory, "pinned_note")).toBe("core");
  });

  // TC-7.E1: CORELINE_AUTO_PROMOTE=0 → { skipped: "disabled" }, no changes.
  test("TC-7.E1: CORELINE_AUTO_PROMOTE=0 disables promotion", () => {
    projectMemory.writeEntry({
      name: "hot_disabled",
      description: "would be promoted if enabled",
      type: "reference",
      body: "body",
      filePath: "",
      tier: "recall",
      accessCount: 10,
    });

    const prev = process.env.CORELINE_AUTO_PROMOTE;
    process.env.CORELINE_AUTO_PROMOTE = "0";
    try {
      const result = promoteByAccessCount({ projectMemory });

      expect(result.skipped).toBe("disabled");
      expect(result.promoted).toBe(0);
      expect(result.promotedNames).toEqual([]);
      expect(tierOf(projectMemory, "hot_disabled")).toBe("recall");
    } finally {
      if (prev === undefined) {
        delete process.env.CORELINE_AUTO_PROMOTE;
      } else {
        process.env.CORELINE_AUTO_PROMOTE = prev;
      }
    }
  });

  // Bonus: dryRun: true → promoted count correct, tierOf unchanged after.
  test("dryRun reports promotions without persisting", () => {
    projectMemory.writeEntry({
      name: "dry_note",
      description: "dry preview",
      type: "reference",
      body: "body",
      filePath: "",
      tier: "recall",
      accessCount: 4,
    });

    const result = promoteByAccessCount({ projectMemory, dryRun: true });

    expect(result.promoted).toBe(1);
    expect(result.promotedNames).toEqual(["dry_note"]);
    expect(result.dryRun).toBe(true);
    // Tier must remain unchanged on disk.
    expect(tierOf(projectMemory, "dry_note")).toBe("recall");
  });

  // Bonus: custom threshold lowers the promotion bar.
  test("custom threshold overrides AUTO_PROMOTE_THRESHOLD", () => {
    projectMemory.writeEntry({
      name: "low_count",
      description: "low access count",
      type: "reference",
      body: "body",
      filePath: "",
      tier: "recall",
      accessCount: 1,
    });

    const result = promoteByAccessCount({ projectMemory, threshold: 1 });

    expect(result.promoted).toBe(1);
    expect(tierOf(projectMemory, "low_count")).toBe("core");
  });

  // Bonus: sessionTickAndMaybePromote runs every N sessions.
  test("sessionTickAndMaybePromote fires every N ticks", () => {
    projectMemory.writeEntry({
      name: "tick_note",
      description: "tick target",
      type: "reference",
      body: "body",
      filePath: "",
      tier: "recall",
      accessCount: 3,
    });

    // everyN=3: first two ticks no-op, third fires.
    const r1 = sessionTickAndMaybePromote(projectMemory, { everyN: 3 });
    expect(r1).toBeNull();
    expect(tierOf(projectMemory, "tick_note")).toBe("recall");

    const r2 = sessionTickAndMaybePromote(projectMemory, { everyN: 3 });
    expect(r2).toBeNull();
    expect(tierOf(projectMemory, "tick_note")).toBe("recall");

    const r3 = sessionTickAndMaybePromote(projectMemory, { everyN: 3 });
    expect(r3).not.toBeNull();
    expect(r3?.promoted).toBe(1);
    expect(tierOf(projectMemory, "tick_note")).toBe("core");
  });
});
