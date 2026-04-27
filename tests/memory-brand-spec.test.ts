/**
 * brand-spec memory type tests — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Tests written independently.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandSpecEntryName,
  buildBrandSpecEntry,
  createBrandSpecTemplate,
  parseBrandSpecBody,
  validateBrandSpec,
} from "../src/memory/brand-spec.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { defaultTierForType } from "../src/memory/tiering.js";
import { tierList } from "../src/memory/tiering.js";
import type { MemoryType } from "../src/memory/types.js";

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "brand-spec-test-"));
}

describe("memory-brand-spec / type system", () => {
  test("MemoryType union admits brand-spec at compile and runtime", () => {
    const t: MemoryType = "brand-spec";
    expect(t).toBe("brand-spec");
  });

  test("defaultTierForType('brand-spec') === 'core'", () => {
    expect(defaultTierForType("brand-spec")).toBe("core");
  });
});

describe("memory-brand-spec / template + validation", () => {
  test("createBrandSpecTemplate includes branded title for the supplied name", () => {
    const md = createBrandSpecTemplate("acme");
    expect(md).toContain("# Brand Spec: acme");
  });

  test("createBrandSpecTemplate contains required section headers", () => {
    const md = createBrandSpecTemplate("contoso");
    expect(md).toContain("## Core Identity");
    expect(md).toContain("## Typography");
    expect(md).toContain("## Tone");
  });

  test("validateBrandSpec on stock template is valid (placeholders surface as warnings)", () => {
    const md = createBrandSpecTemplate("acme");
    const result = validateBrandSpec(md);
    expect(result.valid).toBe(true);
    // Stock template has placeholder logo / primary color → warnings expected.
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("validateBrandSpec on empty body is invalid with errors", () => {
    const result = validateBrandSpec("");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("validateBrandSpec flags missing Core Identity section", () => {
    const md = "# Brand Spec: x\n\n## Typography\n\n## Tone\n";
    const result = validateBrandSpec(md);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Core Identity"))).toBe(true);
  });

  test("buildBrandSpecEntry returns a core/brand-spec entry with the brand-spec-<name> slug", () => {
    const entry = buildBrandSpecEntry("acme");
    expect(entry.tier).toBe("core");
    expect(entry.type).toBe("brand-spec");
    expect(entry.name).toBe("brand-spec-acme");
    expect(entry.importance).toBe("high");
  });
});

describe("memory-brand-spec / round-trip + tier-list integration", () => {
  test("ProjectMemory.writeEntry({type:'brand-spec',...}) round-trips via readEntry", () => {
    const root = mkTmpRoot();
    try {
      const mem = new ProjectMemory("/tmp/brand-spec-rt", { rootDir: root });
      const entry = buildBrandSpecEntry("acme");
      mem.writeEntry({ ...entry, filePath: "" });

      const read = mem.readEntry(brandSpecEntryName("acme"));
      expect(read).not.toBeNull();
      expect(read?.type).toBe("brand-spec");
      expect(read?.tier).toBe("core");
      expect(read?.body).toContain("# Brand Spec: acme");

      const parsed = parseBrandSpecBody(read!.body);
      expect(parsed.name).toBe("acme");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tierList includes brand-spec entries in the core tier group", () => {
    const root = mkTmpRoot();
    try {
      const mem = new ProjectMemory("/tmp/brand-spec-tier", { rootDir: root });
      const entry = buildBrandSpecEntry("acme");
      mem.writeEntry({ ...entry, filePath: "" });

      const coreEntries = tierList(mem, { tier: "core" });
      const found = coreEntries.find((e) => e.name === brandSpecEntryName("acme"));
      expect(found).toBeDefined();
      expect(found?.type).toBe("brand-spec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
