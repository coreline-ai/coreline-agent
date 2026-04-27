/**
 * Wave 7 Phase 3 — Wiki Link Graph (forward only, MVP).
 *
 * Covers: linkScan (full + incremental), linkForward, linkGraph (1-hop / 2-hop /
 * cyclic), linkOrphans, code-fence exclusion, atomic write hygiene.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import { linkForward, linkGraph, linkOrphans, linkScan } from "../src/memory/links.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-links-"));
}

function entry(name: string, body: string, type: MemoryEntry["type"] = "project"): MemoryEntry {
  return { name, description: `${name} desc`, type, body, filePath: "" };
}

describe("Wave 7 Phase 3 — Wiki Link Graph", () => {
  test("TC-3.1: 3 files cross-referencing — linkScan builds correct forward.json", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc31", { rootDir: root });
      mem.writeEntry(entry("Alpha", "Mentions [[Bravo]] and [[Charlie]]."));
      mem.writeEntry(entry("Bravo", "Refers to [[Charlie]]."));
      mem.writeEntry(entry("Charlie", "No links here."));

      const res = linkScan(mem);
      expect(res.written).toBe(true);
      expect(res.filesScanned).toBeGreaterThanOrEqual(3);
      // entitiesLinked = unique entity targets across forward index
      expect(res.entitiesLinked).toBe(2); // Bravo, Charlie

      const fwd = JSON.parse(readFileSync(join(mem.memoryDir, "links", "forward.json"), "utf-8"));
      expect(fwd["Alpha.md"]).toEqual(["Bravo", "Charlie"]);
      expect(fwd["Bravo.md"]).toEqual(["Charlie"]);
      expect(fwd["Charlie.md"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.2: [[Entity]] and [[Entity|display]] both extract entity name", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc32", { rootDir: root });
      mem.writeEntry(entry("Source", "See [[Entity Name]] and [[Aliased|nice text]]."));
      linkScan(mem);
      const targets = linkForward(mem, "Source.md");
      expect(targets).toContain("Entity Name");
      expect(targets).toContain("Aliased");
      expect(targets).not.toContain("nice text");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.3: incremental scan — modifying one file only updates that key", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc33", { rootDir: root });
      mem.writeEntry(entry("A", "Refers to [[X]]."));
      mem.writeEntry(entry("B", "Refers to [[Y]]."));
      linkScan(mem);

      // mutate file A
      mem.writeEntry(entry("A", "Now refers to [[Z]]."));

      const res = linkScan(mem, "A.md");
      expect(res.filesScanned).toBe(1);
      expect(res.written).toBe(true);

      expect(linkForward(mem, "A.md")).toEqual(["Z"]);
      // B untouched
      expect(linkForward(mem, "B.md")).toEqual(["Y"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.4: linkForward returns entities for a given file", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc34", { rootDir: root });
      mem.writeEntry(entry("Source", "Body cites [[Foo]] then [[Bar]]; later [[Foo]] again."));
      linkScan(mem);
      const fwd = linkForward(mem, "Source.md");
      // canonical storage = sorted+deduped (Python parity)
      expect(fwd).toEqual(["Bar", "Foo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.5: linkGraph 1-hop boundary", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc35", { rootDir: root });
      mem.writeEntry(entry("FileA", "Mentions [[Simon]]."));
      mem.writeEntry(entry("FileB", "Mentions [[Hashed]]."));
      mem.writeEntry(entry("Simon", "Mentions [[Hashed]] too."));
      linkScan(mem);

      const g = linkGraph(mem, "Simon", { hops: 1 });
      expect(g.root).toBe("Simon");
      expect(g.hops).toBe(1);
      // 1-hop: files that reference Simon → FileA (and Simon.md itself doesn't reference Simon)
      expect(g.nodes).toContain("Simon");
      expect(g.nodes).toContain("FileA.md");
      // edge: FileA.md → Simon
      expect(g.edges.some((e) => e[0] === "FileA.md" && e[1] === "Simon")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.6: linkGraph 2-hop expansion", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc36", { rootDir: root });
      // FileA → Simon ; Simon (file) → Hashed ; FileC → Hashed
      mem.writeEntry(entry("FileA", "[[Simon]]"));
      mem.writeEntry(entry("Simon", "[[Hashed]]"));
      mem.writeEntry(entry("FileC", "[[Hashed]]"));
      linkScan(mem);

      const g = linkGraph(mem, "Simon", { hops: 2 });
      expect(g.hops).toBe(2);
      // hop 1 reaches FileA.md (refers to Simon) and Simon.md (refers to Hashed)
      // hop 2 from Simon.md → Hashed → other files referring to Hashed (FileC.md)
      expect(g.nodes).toContain("Hashed");
      expect(g.nodes).toContain("Simon");
      expect(g.nodes).toContain("FileA.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.7: cyclic links A → B → A — terminates, both nodes reachable", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc37", { rootDir: root });
      mem.writeEntry(entry("A", "Refers to [[B]]."));
      mem.writeEntry(entry("B", "Refers to [[A]]."));
      linkScan(mem);

      const g = linkGraph(mem, "A", { hops: 2 });
      expect(g.nodes).toContain("A");
      expect(g.nodes).toContain("B");
      // sanity: function returned without infinite loop
      expect(Array.isArray(g.edges)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.8: code fence content NOT extracted", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc38", { rootDir: root });
      const body = [
        "Real link [[OutsideEntity]] here.",
        "",
        "```",
        "code [[FakeEntity]] block",
        "```",
        "",
        "And [[AnotherReal]] after.",
      ].join("\n");
      mem.writeEntry(entry("Source", body));
      linkScan(mem);
      const fwd = linkForward(mem, "Source.md");
      expect(fwd).toContain("OutsideEntity");
      expect(fwd).toContain("AnotherReal");
      expect(fwd).not.toContain("FakeEntity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.9: linkOrphans — undefined entity referenced", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc39", { rootDir: root });
      mem.writeEntry(entry("Defined", "Refers to [[Defined]] and [[Ghost]]."));
      // "Defined.md" exists; "Ghost.md" does not.
      linkScan(mem);
      const orphans = linkOrphans(mem);
      expect(orphans).toContain("Ghost");
      expect(orphans).not.toContain("Defined");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.10: atomic write — forward.json.tmp is removed after success", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc310", { rootDir: root });
      mem.writeEntry(entry("X", "[[Y]]"));
      const res = linkScan(mem);
      expect(res.written).toBe(true);

      const linksDir = join(mem.memoryDir, "links");
      const files = readdirSync(linksDir);
      expect(files).toContain("forward.json");
      expect(files).not.toContain("forward.json.tmp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.11: frontmatter excluded from extraction", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc311", { rootDir: root });
      // ProjectMemory writes its own frontmatter; body itself shouldn't reference accidental [[X]] inside frontmatter.
      // Verify: a raw file with [[InFrontmatter]] inside `---` block must NOT be extracted.
      const rawFile = join(mem.memoryDir, "RawFile.md");
      // ensure storage dir exists — write a normal entry first to materialize memoryDir
      mem.writeEntry(entry("Bootstrap", "noop"));
      writeFileSync(
        rawFile,
        ["---", "name: RawFile", "tag: [[InFrontmatter]]", "---", "Body has [[InBody]]."].join("\n"),
        "utf-8",
      );
      linkScan(mem);
      const fwd = linkForward(mem, "RawFile.md");
      expect(fwd).toContain("InBody");
      expect(fwd).not.toContain("InFrontmatter");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-3.12: links/ subdir is skipped during scan (no self-indexing)", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/links-tc312", { rootDir: root });
      mem.writeEntry(entry("Note", "[[Other]]"));
      const res = linkScan(mem);
      expect(res.written).toBe(true);
      // forward.json sits under links/ — it must not appear as a key
      const fwd = JSON.parse(readFileSync(join(mem.memoryDir, "links", "forward.json"), "utf-8"));
      expect(Object.keys(fwd).every((k) => !k.startsWith("links/"))).toBe(true);
      // sanity: forward.json itself exists
      expect(existsSync(join(mem.memoryDir, "links", "forward.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
