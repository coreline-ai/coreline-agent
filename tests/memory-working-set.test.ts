/**
 * Phase 2 — MemKraft working-set selector (selectWorkingSet, getWorkingSetLimit).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  getWorkingSetLimit,
  selectWorkingSet,
  selectWorkingSetWithStats,
} from "../src/memory/working-set.js";
import { todayIso } from "../src/memory/tiering.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-ws-test-"));
}

function makeMem(cwd: string, rootDir: string): ProjectMemory {
  return new ProjectMemory(cwd, { rootDir });
}

function seed(
  mem: ProjectMemory,
  name: string,
  overrides: Partial<MemoryEntry> = {},
): void {
  mem.writeEntry({
    name,
    description: overrides.description ?? `desc ${name}`,
    type: overrides.type ?? "user",
    body: overrides.body ?? `body ${name}`,
    filePath: "",
    ...overrides,
  });
}

/** Produce ISO date string offset by `daysAgo` from a fixed reference. */
function daysAgoIso(daysAgo: number): string {
  const base = new Date("2026-04-20T00:00:00Z");
  const d = new Date(base.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("memory-working-set / selectWorkingSet", () => {
  test("TC-2.1: 5 core + 10 recall (varied lastAccessed) → 5 core + 3 recent recall (limit 8)", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-1", root);
      for (let i = 0; i < 5; i++) {
        seed(mem, `c${i}`, { tier: "core", lastAccessed: daysAgoIso(i) });
      }
      // 10 recall with staggered dates; most recent will be r0..
      for (let i = 0; i < 10; i++) {
        seed(mem, `r${i}`, { tier: "recall", lastAccessed: daysAgoIso(i + 10) });
      }

      const result = selectWorkingSet({ projectMemory: mem, limit: 8 });
      expect(result.length).toBe(8);
      const names = result.map((e) => e.name);
      // Core come first (5), sorted by lastAccessed desc (c0 newest).
      expect(names.slice(0, 5)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
      // Then 3 most recent recall.
      expect(names.slice(5, 8)).toEqual(["r0", "r1", "r2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.2: 0 core + 20 recall → 8 recall, lastAccessed desc", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-2", root);
      for (let i = 0; i < 20; i++) {
        seed(mem, `r${String(i).padStart(2, "0")}`, {
          tier: "recall",
          lastAccessed: daysAgoIso(i),
        });
      }

      const result = selectWorkingSet({ projectMemory: mem, limit: 8 });
      expect(result.length).toBe(8);
      const names = result.map((e) => e.name);
      expect(names).toEqual([
        "r00",
        "r01",
        "r02",
        "r03",
        "r04",
        "r05",
        "r06",
        "r07",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.3: 12 core + 0 recall → all 12 core (limit 8 exceeded, MemKraft spec)", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-3", root);
      for (let i = 0; i < 12; i++) {
        seed(mem, `c${String(i).padStart(2, "0")}`, {
          tier: "core",
          lastAccessed: daysAgoIso(i),
        });
      }

      const result = selectWorkingSet({ projectMemory: mem, limit: 8 });
      expect(result.length).toBe(12);
      expect(result.every((e) => e.tier === "core")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.4: 0 memories → []", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-4", root);
      const result = selectWorkingSet({ projectMemory: mem, limit: 8 });
      expect(result).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.5: archival excluded even when room available", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-5", root);
      seed(mem, "c1", { tier: "core", lastAccessed: daysAgoIso(1) });
      seed(mem, "r1", { tier: "recall", lastAccessed: daysAgoIso(2) });
      seed(mem, "a1", { tier: "archival", lastAccessed: daysAgoIso(0) });
      seed(mem, "a2", { tier: "archival", lastAccessed: daysAgoIso(0) });

      const stats = selectWorkingSetWithStats({ projectMemory: mem, limit: 8 });
      const names = stats.entries.map((e) => e.name);
      expect(names).toEqual(["c1", "r1"]);
      expect(names.includes("a1")).toBe(false);
      expect(names.includes("a2")).toBe(false);
      expect(stats.archivedCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.6: touch: true → accessCount +1 on returned entries", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-6", root);
      seed(mem, "c1", { tier: "core", accessCount: 2 });
      seed(mem, "r1", { tier: "recall", accessCount: 5 });
      seed(mem, "a1", { tier: "archival", accessCount: 9 });

      const before = {
        c1: mem.readEntry("c1")?.accessCount,
        r1: mem.readEntry("r1")?.accessCount,
        a1: mem.readEntry("a1")?.accessCount,
      };
      expect(before).toEqual({ c1: 2, r1: 5, a1: 9 });

      const result = selectWorkingSet({
        projectMemory: mem,
        limit: 8,
        touch: true,
      });
      const names = result.map((e) => e.name).sort();
      expect(names).toEqual(["c1", "r1"]);

      const after = {
        c1: mem.readEntry("c1")?.accessCount,
        r1: mem.readEntry("r1")?.accessCount,
        a1: mem.readEntry("a1")?.accessCount,
      };
      expect(after.c1).toBe(3);
      expect(after.r1).toBe(6);
      // archival not in working set → untouched
      expect(after.a1).toBe(9);

      // lastAccessed bumped to today for returned entries.
      expect(mem.readEntry("c1")?.lastAccessed).toBe(todayIso());
      expect(mem.readEntry("r1")?.lastAccessed).toBe(todayIso());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.7: CORELINE_WORKING_SET_LIMIT=3 env → limit 3 applied", () => {
    const root = mkTmpRoot();
    const prev = process.env.CORELINE_WORKING_SET_LIMIT;
    try {
      process.env.CORELINE_WORKING_SET_LIMIT = "3";
      expect(getWorkingSetLimit()).toBe(3);

      const mem = makeMem("/tmp/fake-cwd-2-7", root);
      seed(mem, "c1", { tier: "core", lastAccessed: daysAgoIso(0) });
      seed(mem, "c2", { tier: "core", lastAccessed: daysAgoIso(1) });
      for (let i = 0; i < 5; i++) {
        seed(mem, `r${i}`, { tier: "recall", lastAccessed: daysAgoIso(5 + i) });
      }

      const result = selectWorkingSet({
        projectMemory: mem,
        limit: getWorkingSetLimit(),
      });
      expect(result.length).toBe(3);
      expect(result.map((e) => e.name)).toEqual(["c1", "c2", "r0"]);
    } finally {
      if (prev === undefined) {
        delete process.env.CORELINE_WORKING_SET_LIMIT;
      } else {
        process.env.CORELINE_WORKING_SET_LIMIT = prev;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-2.E1: lastAccessed undefined recall sorts last", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-2-E1", root);
      seed(mem, "r_nodate", { tier: "recall" });
      seed(mem, "r_old", { tier: "recall", lastAccessed: daysAgoIso(30) });
      seed(mem, "r_new", { tier: "recall", lastAccessed: daysAgoIso(1) });

      const result = selectWorkingSet({ projectMemory: mem, limit: 8 });
      const names = result.map((e) => e.name);
      expect(names).toEqual(["r_new", "r_old", "r_nodate"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("memory-working-set / getWorkingSetLimit env parsing", () => {
  const prev = process.env.CORELINE_WORKING_SET_LIMIT;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.CORELINE_WORKING_SET_LIMIT;
    } else {
      process.env.CORELINE_WORKING_SET_LIMIT = prev;
    }
  });

  beforeEach(() => {
    delete process.env.CORELINE_WORKING_SET_LIMIT;
  });

  test("default when env unset", () => {
    expect(getWorkingSetLimit()).toBe(8);
  });

  test("default when env non-positive", () => {
    process.env.CORELINE_WORKING_SET_LIMIT = "0";
    expect(getWorkingSetLimit()).toBe(8);
    process.env.CORELINE_WORKING_SET_LIMIT = "-5";
    expect(getWorkingSetLimit()).toBe(8);
  });

  test("default when env non-integer", () => {
    process.env.CORELINE_WORKING_SET_LIMIT = "abc";
    expect(getWorkingSetLimit()).toBe(8);
    process.env.CORELINE_WORKING_SET_LIMIT = "2.5";
    expect(getWorkingSetLimit()).toBe(8);
  });

  test("positive int env applied", () => {
    process.env.CORELINE_WORKING_SET_LIMIT = "12";
    expect(getWorkingSetLimit()).toBe(12);
  });
});
