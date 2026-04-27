/**
 * Phase 1 — MemKraft tier operations (tierSet/Of/Promote/Demote/Touch/List).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  tierDemote,
  tierList,
  tierOf,
  tierPromote,
  tierSet,
  tierTouch,
  todayIso,
} from "../src/memory/tiering.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-tier-test-"));
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

describe("memory-tiering / tier operations", () => {
  test("TC-1.1: tierSet then tierOf returns the new tier", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-1", root);
      seed(mem, "foo");
      tierSet(mem, "foo", "core");
      expect(tierOf(mem, "foo")).toBe("core");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.2: tierOf returns recall (default) when entry has no tier", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-2", root);
      seed(mem, "plain");
      expect(tierOf(mem, "plain")).toBe("recall");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.3: tierSet on non-existent entry throws", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-3", root);
      expect(() => tierSet(mem, "missing", "core")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.4: tierSet with invalid tier throws descriptive Error", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-4", root);
      seed(mem, "foo");
      expect(() => tierSet(mem, "foo", "invalid" as unknown as "core")).toThrow(
        /tier must be one of/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.5: tierPromote walks archival → recall → core → core (no-op)", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-5", root);
      seed(mem, "foo", { tier: "archival" });
      expect(tierPromote(mem, "foo")).toBe("recall");
      expect(tierOf(mem, "foo")).toBe("recall");
      expect(tierPromote(mem, "foo")).toBe("core");
      expect(tierOf(mem, "foo")).toBe("core");
      expect(tierPromote(mem, "foo")).toBe("core");
      expect(tierOf(mem, "foo")).toBe("core");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.6: tierDemote walks core → recall → archival → archival (no-op)", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-6", root);
      seed(mem, "foo", { tier: "core" });
      expect(tierDemote(mem, "foo")).toBe("recall");
      expect(tierOf(mem, "foo")).toBe("recall");
      expect(tierDemote(mem, "foo")).toBe("archival");
      expect(tierOf(mem, "foo")).toBe("archival");
      expect(tierDemote(mem, "foo")).toBe("archival");
      expect(tierOf(mem, "foo")).toBe("archival");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.7: tierTouch sets lastAccessed=today and bumps accessCount", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-7", root);
      seed(mem, "foo", { tier: "recall", accessCount: 2 });

      const updated = tierTouch(mem, "foo");
      expect(updated.lastAccessed).toBe(todayIso());
      expect(updated.accessCount).toBe(3);

      const reread = mem.readEntry("foo");
      expect(reread?.lastAccessed).toBe(todayIso());
      expect(reread?.accessCount).toBe(3);
      // Tier must not change.
      expect(reread?.tier).toBe("recall");

      // Starting from undefined accessCount bumps to 1.
      seed(mem, "bar");
      const updated2 = tierTouch(mem, "bar");
      expect(updated2.accessCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.8: tierList sorts by (tier desc, lastAccessed desc)", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-8", root);
      // 3 core, 5 recall, 2 archival — non-contiguous dates.
      seed(mem, "c1", { tier: "core", lastAccessed: "2026-04-10" });
      seed(mem, "c2", { tier: "core", lastAccessed: "2026-04-22" });
      seed(mem, "c3", { tier: "core", lastAccessed: "2026-04-15" });

      seed(mem, "r1", { tier: "recall", lastAccessed: "2026-04-01" });
      seed(mem, "r2", { tier: "recall", lastAccessed: "2026-04-20" });
      seed(mem, "r3", { tier: "recall", lastAccessed: "2026-04-05" });
      seed(mem, "r4", { tier: "recall", lastAccessed: "2026-04-18" });
      seed(mem, "r5", { tier: "recall" }); // no lastAccessed → last within tier

      seed(mem, "a1", { tier: "archival", lastAccessed: "2026-01-01" });
      seed(mem, "a2", { tier: "archival", lastAccessed: "2026-02-14" });

      const list = tierList(mem);
      const names = list.map((e) => e.name);

      // Core block (indexes 0..2) sorted by lastAccessed desc.
      expect(names.slice(0, 3)).toEqual(["c2", "c3", "c1"]);
      // Recall block — r5 (no lastAccessed) sorts last.
      expect(names.slice(3, 8)).toEqual(["r2", "r4", "r3", "r1", "r5"]);
      // Archival block — most recent first.
      expect(names.slice(8, 10)).toEqual(["a2", "a1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.9: tierList with tier filter returns only that tier", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-9", root);
      seed(mem, "c1", { tier: "core", lastAccessed: "2026-04-10" });
      seed(mem, "c2", { tier: "core", lastAccessed: "2026-04-22" });
      seed(mem, "r1", { tier: "recall", lastAccessed: "2026-04-01" });
      seed(mem, "a1", { tier: "archival" });

      const onlyCore = tierList(mem, { tier: "core" });
      expect(onlyCore.map((e) => e.name)).toEqual(["c2", "c1"]);
      expect(onlyCore.every((e) => e.tier === "core")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.E1: corrupted tier value in frontmatter → tierOf returns recall, no error", () => {
    const root = mkTmpRoot();
    try {
      const mem = makeMem("/tmp/fake-cwd-1-E1", root);
      seed(mem, "junky");
      const stored = mem.readEntry("junky");
      expect(stored).not.toBeNull();
      // Corrupt the on-disk tier manually.
      const raw = readFileSync(stored!.filePath, "utf-8");
      const corrupted = raw.replace(
        /^---\n/,
        `---\ntier: junk\n`,
      );
      writeFileSync(stored!.filePath, corrupted, "utf-8");

      // tierOf should silently fall back to DEFAULT_TIER.
      expect(tierOf(mem, "junky")).toBe("recall");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
