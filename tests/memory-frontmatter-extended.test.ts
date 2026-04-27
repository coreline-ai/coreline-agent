/**
 * Phase 0 — Round-trip tests for MemoryEntry extended frontmatter fields.
 *
 * Validates that tier/lastAccessed/accessCount/importance survive
 * write → serialize → parse → read without loss, and that legacy memory
 * files (without these fields) remain byte-compatible.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMemoryFile,
  serializeMemoryFile,
  extractExtendedFields,
} from "../src/memory/memory-parser.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-fm-test-"));
}

describe("memory-parser / extended frontmatter", () => {
  test("TC-0.1: serializeMemoryFile includes tier when provided", () => {
    const out = serializeMemoryFile({
      name: "foo",
      description: "desc",
      type: "user",
      body: "hello",
      tier: "core",
    });
    expect(out).toContain("tier: core");
  });

  test("TC-0.2: parseMemoryFile returns tier/lastAccessed/accessCount fields raw", () => {
    const content = `---
name: foo
description: desc
type: user
tier: archival
lastAccessed: 2026-04-25
accessCount: 5
---
body`;
    const { frontmatter } = parseMemoryFile(content);
    expect(frontmatter.tier).toBe("archival");
    expect(frontmatter.lastAccessed).toBe("2026-04-25");
    expect(frontmatter.accessCount).toBe(5);
  });

  test("TC-0.3: legacy files without extended fields parse without errors", () => {
    const content = `---
name: legacy
description: old style
type: project
---
body only`;
    const { frontmatter, body } = parseMemoryFile(content);
    expect(frontmatter.name).toBe("legacy");
    expect(frontmatter.tier).toBeUndefined();
    expect(body).toBe("body only");
  });

  test("TC-0.4: serializeMemoryFile without extended fields is byte-identical to legacy form", () => {
    const legacy = serializeMemoryFile({
      name: "foo",
      description: "desc",
      type: "user",
      body: "hello",
    });
    // Expected legacy shape: name/description/type only, no other keys.
    expect(legacy).toBe(`---\nname: foo\ndescription: desc\ntype: user\n---\nhello`);
  });

  test("TC-0.5: round-trip via ProjectMemory preserves all extended fields", () => {
    const root = mkTmpRoot();
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd", { rootDir: root });
      const projectId = mem.projectId;
      expect(projectId).toBeTruthy();

      const entry: MemoryEntry = {
        name: "round-trip",
        description: "check all fields",
        type: "feedback",
        body: "the body",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-25",
        accessCount: 7,
        importance: "high",
      };
      mem.writeEntry(entry);

      const read = mem.readEntry("round-trip");
      expect(read).not.toBeNull();
      expect(read?.tier).toBe("core");
      expect(read?.lastAccessed).toBe("2026-04-25");
      expect(read?.accessCount).toBe(7);
      expect(read?.importance).toBe("high");
      expect(read?.body).toBe("the body");

      // Verify the file on disk actually contains these keys.
      const fileContent = readFileSync(read!.filePath, "utf-8");
      expect(fileContent).toContain("tier: core");
      expect(fileContent).toContain("lastAccessed: 2026-04-25");
      expect(fileContent).toContain("accessCount: 7");
      expect(fileContent).toContain("importance: high");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-0.6: legacy memory (no tier) reads back with tier=undefined", () => {
    const root = mkTmpRoot();
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-2", { rootDir: root });
      mem.writeEntry({
        name: "plain",
        description: "no extras",
        type: "user",
        body: "just body",
        filePath: "",
      });
      const read = mem.readEntry("plain");
      expect(read).not.toBeNull();
      expect(read?.tier).toBeUndefined();
      expect(read?.lastAccessed).toBeUndefined();
      expect(read?.accessCount).toBeUndefined();
      expect(read?.importance).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-0.E1: invalid tier value → extractExtendedFields returns undefined (silent fallback)", () => {
    const extracted = extractExtendedFields({ tier: "junk_value", lastAccessed: "2026-04-25" });
    expect(extracted.tier).toBeUndefined();
    expect(extracted.lastAccessed).toBe("2026-04-25");
  });

  test("TC-0.E2: non-numeric accessCount → undefined, other fields intact", () => {
    const extracted = extractExtendedFields({
      tier: "recall",
      accessCount: "not-a-number",
      importance: "low",
    });
    expect(extracted.accessCount).toBeUndefined();
    expect(extracted.tier).toBe("recall");
    expect(extracted.importance).toBe("low");
  });

  test("invalid importance value is rejected", () => {
    const extracted = extractExtendedFields({ importance: "critical" });
    expect(extracted.importance).toBeUndefined();
  });

  test("negative accessCount is rejected", () => {
    const extracted = extractExtendedFields({ accessCount: -1 });
    expect(extracted.accessCount).toBeUndefined();
  });
});
