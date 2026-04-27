/**
 * Wave 7 Phase 4 — Document Chunking + IngestDocument (chunkText/trackDocument/searchPrecise).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  chunkText,
  searchPrecise,
  trackDocument,
} from "../src/memory/chunking.js";
import { MAX_CHUNKS_PER_DOC } from "../src/memory/constants.js";

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-chunking-"));
}

describe("Wave 7 Phase 4 — chunkText", () => {
  test("TC-4.1: chunkText('a b c d e', size=2, overlap=0) splits into ['a b','c d','e']", () => {
    const out = chunkText("a b c d e", 2, 0);
    expect(out).toEqual(["a b", "c d", "e"]);
  });

  test("TC-4.2: chunkText with overlap=1, size=3 — step=2", () => {
    const out = chunkText("a b c d e f", 3, 1);
    // step=2, windows: [0:3]=a b c, [2:5]=c d e, [4:7]=e f
    expect(out).toEqual(["a b c", "c d e", "e f"]);
  });

  test("TC-4.3: small text (<= size) returns single chunk", () => {
    const out = chunkText("hello world", 500, 50);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("hello world");
  });

  test("TC-4.4: empty text returns empty array", () => {
    expect(chunkText("", 10, 0)).toEqual([]);
    expect(chunkText("   ", 10, 0)).toEqual([]);
  });

  test("TC-4.5: overlap >= size throws", () => {
    expect(() => chunkText("a b c", 2, 2)).toThrow(/overlap/);
    expect(() => chunkText("a b c", 2, 3)).toThrow(/overlap/);
  });
});

describe("Wave 7 Phase 4 — trackDocument", () => {
  test("TC-4.6: creates parent + N chunk entries with `{docId}__c{i}` naming", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc46", { rootDir: root });
      const text = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
      const result = trackDocument(mem, "doc1", text, {
        chunkSize: 5,
        chunkOverlap: 1,
      });

      // step=4, windows: [0:5], [4:9], [8:13] -> 3 chunks
      expect(result.docId).toBe("doc1");
      expect(result.parentTracked).toBe(true);
      expect(result.chunksCreated).toBe(3);
      expect(result.failures).toEqual([]);

      const parent = mem.readEntry("doc1");
      expect(parent).not.toBeNull();
      expect(parent!.body).toContain("(chunks: 3)");

      const c0 = mem.readEntry("doc1__c0");
      const c1 = mem.readEntry("doc1__c1");
      const c2 = mem.readEntry("doc1__c2");
      expect(c0).not.toBeNull();
      expect(c1).not.toBeNull();
      expect(c2).not.toBeNull();
      expect(c0!.body).toBe("word0 word1 word2 word3 word4");
      expect(c1!.description).toBe("chunk 2/3 of doc1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-4.7: chunks > MAX_CHUNKS_PER_DOC throws", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc47", { rootDir: root });
      // size=1, overlap=0 → chunks == words
      const wordCount = MAX_CHUNKS_PER_DOC + 5;
      const text = Array.from({ length: wordCount }, (_, i) => `w${i}`).join(" ");
      expect(() =>
        trackDocument(mem, "huge", text, { chunkSize: 1, chunkOverlap: 0 }),
      ).toThrow(/exceeds max/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-4.7b: chunkOverlap >= chunkSize throws on trackDocument", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc47b", { rootDir: root });
      expect(() =>
        trackDocument(mem, "bad", "a b c d e", {
          chunkSize: 3,
          chunkOverlap: 3,
        }),
      ).toThrow(/overlap/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Wave 7 Phase 4 — searchPrecise", () => {
  test("TC-4.8: exact substring match returns chunk(s) without fallback", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc48", { rootDir: root });
      mem.writeEntry({
        name: "alpha",
        description: "alpha doc",
        type: "reference",
        body: "the quick brown fox jumps over the lazy dog",
        filePath: "",
        tier: "recall",
      });
      mem.writeEntry({
        name: "beta",
        description: "beta doc",
        type: "reference",
        body: "completely unrelated content about databases",
        filePath: "",
        tier: "recall",
      });

      const res = searchPrecise(mem, "quick brown");
      expect(res.fallbackUsed).toBe(false);
      expect(res.results.length).toBe(1);
      expect(res.results[0]!.name).toBe("alpha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-4.9: no exact match → fuzzy fallback returns top-K", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc49", { rootDir: root });
      mem.writeEntry({
        name: "doc-a",
        description: "alpha",
        type: "reference",
        body: "deployment kubernetes pipeline rollout",
        filePath: "",
        tier: "recall",
      });
      mem.writeEntry({
        name: "doc-b",
        description: "beta",
        type: "reference",
        body: "completely different terms about cooking recipes",
        filePath: "",
        tier: "recall",
      });

      // Query: "kubernetes deployment" — both terms appear in doc-a in non-adjacent
      // order. Exact-substring (full multi-word) requires both as separate words —
      // this still matches doc-a containment. So use a query that doesn't match
      // exactly to force fuzzy: separate words present, but query has a word missing.
      const res = searchPrecise(mem, "kubernetes deployment xyznotfound", {
        topK: 5,
        scoreThreshold: 0.1,
      });
      expect(res.fallbackUsed).toBe(true);
      expect(res.results.length).toBeGreaterThanOrEqual(1);
      // doc-a should score higher than doc-b because it contains 2/3 query tokens
      expect(res.results[0]!.name).toBe("doc-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-4.10: no hits at all → empty results, fallbackUsed true", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc410", { rootDir: root });
      mem.writeEntry({
        name: "only",
        description: "hello",
        type: "reference",
        body: "hello world",
        filePath: "",
        tier: "recall",
      });

      const res = searchPrecise(mem, "zzznoneexistentxyz", {
        topK: 5,
        scoreThreshold: 0.1,
      });
      expect(res.results).toEqual([]);
      expect(res.fallbackUsed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-4.10b: empty query returns empty without fallback", () => {
    const root = mkRoot();
    try {
      const mem = new ProjectMemory("/tmp/chunking-tc410b", { rootDir: root });
      const res = searchPrecise(mem, "   ");
      expect(res.results).toEqual([]);
      expect(res.fallbackUsed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
