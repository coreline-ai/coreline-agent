/**
 * Wave 10 P3 R4 — `decayRestore` legacy tombstone recovery via sanitized name
 * variants (spaces, slashes, Korean). Verifies that historical entries whose
 * filenames don't match the current `entryFileName` slug can still be revived.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureTombstonesDir } from "../src/config/paths.js";
import { decayRestore } from "../src/memory/decay.js";
import { ProjectMemory } from "../src/memory/project-memory.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "decay-legacy-"));
}

describe("decayRestore — legacy names (R4)", () => {
  test("name with space restores via underscore variant", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy-restore-1", { rootDir: root });
      const tombDir = ensureTombstonesDir(mem.projectId, root);
      writeFileSync(
        join(tombDir, "my_old_entry.md"),
        `---\nname: my_old_entry\ndescription: old\ntype: project\ntombstoned: true\ntombstonedAt: 2026-01-01T00:00:00Z\n---\nbody`,
      );
      const result = decayRestore(mem, "my old entry");
      expect(result.tombstoned).toBe(false);
      expect(result.decayWeight).toBe(1.0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Korean name restores correctly", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy-restore-2", { rootDir: root });
      const tombDir = ensureTombstonesDir(mem.projectId, root);
      writeFileSync(
        join(tombDir, "한국어_엔트리.md"),
        `---\nname: 한국어_엔트리\ndescription: ko\ntype: project\ntombstoned: true\n---\nbody`,
      );
      const result = decayRestore(mem, "한국어 엔트리");
      expect(result.tombstoned).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("special chars (slash) sanitized", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy-restore-3", { rootDir: root });
      const tombDir = ensureTombstonesDir(mem.projectId, root);
      writeFileSync(
        join(tombDir, "path_to_entry.md"),
        `---\nname: path_to_entry\ndescription: x\ntype: project\ntombstoned: true\n---\nbody`,
      );
      const result = decayRestore(mem, "path/to/entry");
      expect(result.tombstoned).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("collision suffix (.1, .2) still found", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy-restore-4", { rootDir: root });
      const tombDir = ensureTombstonesDir(mem.projectId, root);
      writeFileSync(
        join(tombDir, "duplicate.1.md"),
        `---\nname: duplicate\ndescription: x\ntype: project\ntombstoned: true\n---\nbody`,
      );
      const result = decayRestore(mem, "duplicate");
      expect(result.tombstoned).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-existent name throws (not in tombstones)", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy-restore-5", { rootDir: root });
      expect(() => decayRestore(mem, "nonexistent_entry")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
