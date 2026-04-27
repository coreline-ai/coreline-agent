/**
 * Wave 10 F4 — Wiki Link Backlinks (bidirectional companion).
 *
 * Covers: linkBacklinks lookups, backlinks.json built alongside forward.json,
 * inverse mapping correctness, linkGraph direction (forward/backward/both),
 * corrupt index tolerance, idempotent rebuild, incremental survival,
 * default-direction regression.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  linkBacklinks,
  readBacklinks,
  rebuildBacklinks,
  inverseForward,
} from "../src/memory/links-backlinks.js";
import { linkGraph, linkScan } from "../src/memory/links.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-backlinks-"));
}

function entry(name: string, body: string, type: MemoryEntry["type"] = "project"): MemoryEntry {
  return { name, description: `${name} desc`, type, body, filePath: "" };
}

function backlinksFile(memoryDir: string): string {
  return join(memoryDir, "links", "backlinks.json");
}

describe("Wave 10 F4 — backlinks", () => {
  test("F4.1: linkBacklinks returns files referencing entity", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-1", { rootDir: root });
      mem.writeEntry(entry("Alpha", "Mentions [[Bravo]] and [[Charlie]]."));
      mem.writeEntry(entry("Bravo", "Refers to [[Charlie]]."));
      mem.writeEntry(entry("Charlie", "No links here."));
      linkScan(mem);

      expect(linkBacklinks(mem, "Charlie")).toEqual(["Alpha.md", "Bravo.md"]);
      expect(linkBacklinks(mem, "Bravo")).toEqual(["Alpha.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.2: linkBacklinks for un-referenced entity → []", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-2", { rootDir: root });
      mem.writeEntry(entry("Solo", "[[Other]]"));
      linkScan(mem);
      expect(linkBacklinks(mem, "Ghost")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.3: backlinks.json built alongside forward.json by linkScan", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-3", { rootDir: root });
      mem.writeEntry(entry("A", "[[X]]"));
      const res = linkScan(mem);
      expect(res.written).toBe(true);
      expect(existsSync(backlinksFile(mem.memoryDir))).toBe(true);
      const blnk = JSON.parse(readFileSync(backlinksFile(mem.memoryDir), "utf-8"));
      expect(blnk["X"]).toEqual(["A.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.4: 3 cross-references — backlinks reflect them", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-4", { rootDir: root });
      mem.writeEntry(entry("A", "[[Hub]] [[Other]]"));
      mem.writeEntry(entry("B", "[[Hub]]"));
      mem.writeEntry(entry("C", "[[Hub]]"));
      linkScan(mem);
      const blnk = readBacklinks(mem);
      expect(blnk["Hub"]).toEqual(["A.md", "B.md", "C.md"]);
      expect(blnk["Other"]).toEqual(["A.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.5: linkGraph direction:'backward' traverses via backlinks", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-5", { rootDir: root });
      mem.writeEntry(entry("Source1", "[[Target]]"));
      mem.writeEntry(entry("Source2", "[[Target]]"));
      mem.writeEntry(entry("Target", "[[Other]]"));
      linkScan(mem);

      const g = linkGraph(mem, "Target", { hops: 1, direction: "backward" });
      expect(g.nodes).toContain("Target");
      expect(g.nodes).toContain("Source1.md");
      expect(g.nodes).toContain("Source2.md");
      // backward edge: src → Target
      expect(g.edges.some((e) => e[0] === "Source1.md" && e[1] === "Target")).toBe(true);
      expect(g.edges.some((e) => e[0] === "Source2.md" && e[1] === "Target")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.6: linkGraph direction:'both' = union of forward + backward", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-6", { rootDir: root });
      mem.writeEntry(entry("Source1", "[[Hub]]"));
      mem.writeEntry(entry("Hub", "[[Downstream]]"));
      linkScan(mem);

      const g = linkGraph(mem, "Hub", { hops: 1, direction: "both" });
      // backward reaches Source1.md
      expect(g.nodes).toContain("Source1.md");
      // forward reaches Downstream (via Hub.md self-file traversal)
      expect(g.nodes).toContain("Hub.md");
      expect(g.nodes).toContain("Downstream");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.7: corrupt backlinks.json doesn't block reads — treated as empty", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-7", { rootDir: root });
      mem.writeEntry(entry("A", "[[B]]"));
      linkScan(mem);
      // overwrite backlinks.json with garbage
      writeFileSync(backlinksFile(mem.memoryDir), "{ corrupt json", "utf-8");
      // readBacklinks should return {} silently (with warn)
      const blnk = readBacklinks(mem);
      expect(blnk).toEqual({});
      // linkBacklinks similarly returns []
      expect(linkBacklinks(mem, "B")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.8: rebuildBacklinks idempotent — same output on repeated calls", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-8", { rootDir: root });
      mem.writeEntry(entry("A", "[[X]] [[Y]]"));
      mem.writeEntry(entry("B", "[[Y]] [[Z]]"));
      linkScan(mem);
      const first = readFileSync(backlinksFile(mem.memoryDir), "utf-8");
      rebuildBacklinks(mem);
      const second = readFileSync(backlinksFile(mem.memoryDir), "utf-8");
      expect(second).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.9: backlinks survive incremental linkScan", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-9", { rootDir: root });
      mem.writeEntry(entry("A", "[[X]]"));
      mem.writeEntry(entry("B", "[[Y]]"));
      linkScan(mem);
      // mutate A: replace [[X]] with [[Z]]
      mem.writeEntry(entry("A", "[[Z]]"));
      linkScan(mem, "A.md");

      const blnk = readBacklinks(mem);
      // Y still backlinked from B
      expect(blnk["Y"]).toEqual(["B.md"]);
      // Z now backlinked from A
      expect(blnk["Z"]).toEqual(["A.md"]);
      // X removed
      expect(blnk["X"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.10: existing linkGraph default direction (forward) regression", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/blnk-10", { rootDir: root });
      mem.writeEntry(entry("FileA", "Mentions [[Simon]]."));
      mem.writeEntry(entry("Simon", "Mentions [[Hashed]]."));
      linkScan(mem);

      // Default direction === "forward" — must match prior tests (TC-3.5/3.6)
      const g = linkGraph(mem, "Simon", { hops: 1 });
      expect(g.nodes).toContain("Simon");
      expect(g.nodes).toContain("FileA.md");
      expect(g.edges.some((e) => e[0] === "FileA.md" && e[1] === "Simon")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4.11: inverseForward pure-function correctness", () => {
    expect(
      inverseForward({
        "A.md": ["X", "Y"],
        "B.md": ["Y"],
      }),
    ).toEqual({
      X: ["A.md"],
      Y: ["A.md", "B.md"],
    });
  });
});
