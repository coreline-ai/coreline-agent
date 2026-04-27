/**
 * Wave 10 P3 O2 — tierList LRU cache tests.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { tierList, tierSet, tierTouch } from "../src/memory/tiering.js";
import {
  cacheStats,
  invalidate,
  invalidateAll,
  setCached,
  getCached,
} from "../src/memory/tier-list-cache.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "tier-cache-"));
}

describe("tierList cache (O2)", () => {
  beforeEach(() => {
    invalidateAll();
  });

  test("first call → miss; second → hit", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/cache-1", { rootDir: root });
      mem.writeEntry({ name: "a", description: "d", type: "user", body: "x", filePath: "" });

      const before = cacheStats();
      tierList(mem);
      tierList(mem);
      const after = cacheStats();

      expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
      expect(after.hits).toBeGreaterThanOrEqual(before.hits + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeEntry invalidates cache", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/cache-2", { rootDir: root });
      mem.writeEntry({ name: "a", description: "d", type: "user", body: "x", filePath: "" });
      tierList(mem); // populate cache

      // Verify cache populated
      expect(getCached(mem.projectId)).not.toBeNull();

      mem.writeEntry({ name: "b", description: "d", type: "user", body: "y", filePath: "" });

      // After write, cache should be invalidated
      expect(getCached(mem.projectId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleteEntry invalidates cache", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/cache-3", { rootDir: root });
      mem.writeEntry({ name: "a", description: "d", type: "user", body: "x", filePath: "" });
      tierList(mem);
      expect(getCached(mem.projectId)).not.toBeNull();

      mem.deleteEntry("a");
      expect(getCached(mem.projectId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tierSet invalidates", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/cache-4", { rootDir: root });
      mem.writeEntry({ name: "a", description: "d", type: "user", body: "x", filePath: "" });
      tierList(mem);
      expect(getCached(mem.projectId)).not.toBeNull();

      tierSet(mem, "a", "core");
      expect(getCached(mem.projectId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tierTouch invalidates", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/cache-5", { rootDir: root });
      mem.writeEntry({ name: "a", description: "d", type: "user", body: "x", filePath: "" });
      tierList(mem);
      expect(getCached(mem.projectId)).not.toBeNull();

      tierTouch(mem, "a");
      expect(getCached(mem.projectId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit invalidate(projectId) clears single project", () => {
    setCached("p1", []);
    setCached("p2", []);
    invalidate("p1");
    expect(getCached("p1")).toBeNull();
    expect(getCached("p2")).not.toBeNull();
  });

  test("invalidateAll clears all", () => {
    setCached("p1", []);
    setCached("p2", []);
    invalidateAll();
    expect(getCached("p1")).toBeNull();
    expect(getCached("p2")).toBeNull();
  });

  test("MEMORY_TIER_CACHE_ENABLE=false disables cache", () => {
    const prev = process.env.MEMORY_TIER_CACHE_ENABLE;
    process.env.MEMORY_TIER_CACHE_ENABLE = "false";
    try {
      const root = mkTmp();
      try {
        const mem = new ProjectMemory("/tmp/cache-6", { rootDir: root });
        mem.writeEntry({ name: "a", description: "d", type: "user", body: "x", filePath: "" });

        tierList(mem);
        tierList(mem);

        // No cache entry should be set
        expect(getCached(mem.projectId)).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (prev === undefined) delete process.env.MEMORY_TIER_CACHE_ENABLE;
      else process.env.MEMORY_TIER_CACHE_ENABLE = prev;
    }
  });
});
