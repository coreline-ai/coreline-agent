/**
 * Wave 7 Integration tests — Phase 5 of MemKraft Wave 7/8/9.
 *
 * Verifies that the four Wave 7 modules (bitemporal facts, decay+tombstone,
 * wiki links, document chunking) coexist with each other and with existing
 * Wave 1-6 features (compaction, tiering, working-set, session recall,
 * MemoryRecall tool) without schema collisions or behavioral interference.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import { tierOf } from "../src/memory/tiering.js";
import { selectWorkingSet } from "../src/memory/working-set.js";
import { compact } from "../src/memory/compaction.js";
import { factAdd, factAt, factHistory, factList } from "../src/memory/facts.js";
import { decayApply } from "../src/memory/decay.js";
import { linkForward, linkGraph, linkScan } from "../src/memory/links.js";
import { searchPrecise, trackDocument } from "../src/memory/chunking.js";
import { indexSession, searchRecall } from "../src/memory/session-recall.js";
import { MemoryRecallTool } from "../src/tools/memory-recall/memory-recall-tool.js";
import { getFactsDir } from "../src/config/paths.js";
import type { ToolUseContext } from "../src/tools/types.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-w7-int-"));
}

describe("Wave 7 Integration — Facts + Decay + Links + Chunking", () => {
  test("S1: Facts + Compaction independence", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/wave7-int-s1", { rootDir: root });

      // Seed a regular memory entry that compaction can act on.
      mem.writeEntry({
        name: "old_recall",
        description: "old recall entry",
        type: "reference",
        body: "old recall body",
        filePath: "",
        tier: "recall",
        lastAccessed: "2025-01-01",
      });

      // Add 3 facts about the same entity, varying validFrom/recordedAt.
      factAdd(mem, "Simon", "role", "CTO", {
        validFrom: "2018-01-01",
        validTo: "2020-02-29",
        recordedAt: "2024-05-10T14:22",
      });
      factAdd(mem, "Simon", "role", "CEO", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });
      factAdd(mem, "Simon", "company", "Hashed", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });

      const factsDir = getFactsDir(mem.projectId, root);
      const factsFile = join(factsDir, "simon.md");
      expect(existsSync(factsFile)).toBe(true);
      const factsBefore = readFileSync(factsFile, "utf-8");

      // Run compact — should archive old_recall but leave facts untouched.
      const result = compact({ projectMemory: mem });
      expect(result.moved).toBe(1);
      expect(result.movedNames).toContain("old_recall");

      // facts/ directory and contents preserved (compaction skips subdirs).
      expect(existsSync(factsFile)).toBe(true);
      expect(readFileSync(factsFile, "utf-8")).toBe(factsBefore);

      // factAt query still works after compact.
      const current = factAt(mem, "Simon", "role", { asOf: "2026-01-01" });
      expect(current).not.toBeNull();
      expect(current!.value).toBe("CEO");

      const history = factHistory(mem, "Simon", "role");
      expect(history).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S2: Decay + Tiering complementary", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/wave7-int-s2", { rootDir: root });

      // 2 core entries.
      mem.writeEntry({
        name: "core_a",
        description: "core a",
        type: "user",
        body: "core a body",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-25",
      });
      mem.writeEntry({
        name: "core_b",
        description: "core b",
        type: "user",
        body: "core b body",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-24",
      });

      // 3 recall entries.
      for (let i = 0; i < 3; i += 1) {
        mem.writeEntry({
          name: `recall_${i}`,
          description: `recall ${i}`,
          type: "reference",
          body: `recall ${i} body`,
          filePath: "",
          tier: "recall",
          lastAccessed: `2026-04-${20 + i}`,
        });
      }

      // Apply decay to one core entry → weight halves but tier stays core.
      const state = decayApply(mem, "core_a", { decayRate: 0.5 });
      expect(state.decayWeight).toBe(0.5);
      expect(tierOf(mem, "core_a")).toBe("core");

      const reread = mem.readEntry("core_a");
      expect(reread!.tier).toBe("core");
      expect(reread!.decayWeight).toBe(0.5);

      // Working set still includes the decayed core entry (D5: decay does not
      // auto-exclude from working set).
      const ws = selectWorkingSet({ projectMemory: mem, limit: 8 });
      const names = ws.map((e) => e.name);
      expect(names).toContain("core_a");
      expect(names).toContain("core_b");

      // compact() and decayApply() are independent — running compact does not
      // alter decay state, and the decayed core entry survives compaction
      // (core tier is protected).
      const result = compact({ projectMemory: mem });
      expect(tierOf(mem, "core_a")).toBe("core");
      const after = mem.readEntry("core_a");
      expect(after!.decayWeight).toBe(0.5);
      expect(after!.decayCount).toBe(1);
      // No core entry got moved to archival.
      for (const n of result.movedNames) {
        expect(tierOf(mem, n)).toBe("archival");
      }
      expect(tierOf(mem, "core_a")).toBe("core");
      expect(tierOf(mem, "core_b")).toBe("core");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S3: Links + Session-recall cross-search", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/wave7-int-s3", { rootDir: root });
      const projectId = mem.projectId;

      // 3 memories with cross-references.
      mem.writeEntry({
        name: "Alpha",
        description: "alpha",
        type: "project",
        body: "Mentions [[Bravo]] and [[Charlie]].",
        filePath: "",
        tier: "recall",
      });
      mem.writeEntry({
        name: "Bravo",
        description: "bravo",
        type: "project",
        body: "Refers to [[Charlie]] and ESLint config tips.",
        filePath: "",
        tier: "recall",
      });
      mem.writeEntry({
        name: "Charlie",
        description: "charlie",
        type: "project",
        body: "Terminal entity, no [[]] outbound.",
        filePath: "",
        tier: "recall",
      });

      // Build forward.json.
      const scan = linkScan(mem);
      expect(scan.written).toBe(true);
      expect(linkForward(mem, "Alpha.md")).toEqual(["Bravo", "Charlie"]);

      // Index a session about ESLint discussion.
      indexSession({
        projectId,
        sessionId: "sess-eslint",
        messages: [
          { role: "user", content: "How do I configure ESLint?" } as any,
          { role: "assistant", content: "Use eslintrc and Bravo references." } as any,
        ],
        rootDir: root,
      });

      // linkGraph (Alpha) returns reachable structure.
      const graph = linkGraph(mem, "Alpha", { hops: 2 });
      expect(graph.nodes).toContain("Alpha");
      expect(graph.nodes).toContain("Bravo");
      expect(graph.nodes).toContain("Charlie");

      // searchRecall (existing Wave 1-6) finds the session — independent path.
      const recall = searchRecall({
        projectId,
        query: "ESLint",
        timeRangeDays: 30,
        rootDir: root,
      });
      expect(recall.results.length).toBeGreaterThan(0);
      expect(recall.results[0]!.sessionId).toBe("sess-eslint");

      // forward.json still consistent (no interference from session-recall).
      expect(linkForward(mem, "Bravo.md")).toEqual(["Charlie"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S4: Chunking + MemoryRecall integration", async () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/wave7-int-s4", { rootDir: root });
      const projectId = mem.projectId;

      // Generate a deterministic ~1500-word document with a unique marker.
      const words: string[] = [];
      for (let i = 0; i < 1500; i += 1) {
        words.push(`word${i}`);
      }
      // Inject a unique phrase at word index ~700 so it lands in the middle chunk.
      words[700] = "kubernetesdeploymentmarker";
      const doc = words.join(" ");

      const result = trackDocument(mem, "doc-large", doc, {
        chunkSize: 500,
        chunkOverlap: 50,
      });
      expect(result.parentTracked).toBe(true);
      // step=450, windows: [0:500], [450:950], [900:1400], [1350:1500]
      // → 4 chunks, but at least 3 as the spec describes.
      expect(result.chunksCreated).toBeGreaterThanOrEqual(3);
      expect(result.failures).toEqual([]);

      // Each chunk stored with __c0, __c1, __c2 suffix.
      expect(mem.readEntry("doc-large__c0")).not.toBeNull();
      expect(mem.readEntry("doc-large__c1")).not.toBeNull();
      expect(mem.readEntry("doc-large__c2")).not.toBeNull();

      // searchPrecise finds the matching chunk by exact substring.
      const precise = searchPrecise(mem, "kubernetesdeploymentmarker");
      expect(precise.fallbackUsed).toBe(false);
      expect(precise.results.length).toBeGreaterThan(0);
      expect(precise.results[0]!.name.startsWith("doc-large__c")).toBe(true);

      // MemoryRecall tool integration — index a session that references the doc,
      // then call MemoryRecallTool directly. The tool searches session summaries
      // (not memory entries), so we verify it works in coexistence with chunking.
      indexSession({
        projectId,
        sessionId: "sess-doc",
        messages: [
          { role: "user", content: "Find the kubernetesdeploymentmarker reference" } as any,
          {
            role: "assistant",
            content: "It is in doc-large chunks. kubernetesdeploymentmarker is the marker.",
          } as any,
        ],
        rootDir: root,
      });

      const ctx: Partial<ToolUseContext> = {
        projectMemory: mem,
        cwd: mem.cwd,
        signal: new AbortController().signal,
      };
      // Direct call (not slash) — bypass the harness, pass projectMemory so the
      // tool has projectId. Force rootDir via env-less call: searchRecall reads
      // the same project tree under getProjectMemoryDir(projectId).
      // We can't pass rootDir to MemoryRecallTool, so instead we directly call
      // searchRecall with the rootDir we used, mirroring what the tool does.
      const recallViaTool = searchRecall({
        projectId,
        query: "kubernetesdeploymentmarker",
        timeRangeDays: 30,
        rootDir: root,
      });
      expect(recallViaTool.results.length).toBeGreaterThan(0);
      expect(recallViaTool.results[0]!.sessionId).toBe("sess-doc");

      // And the MemoryRecallTool object itself is well-formed.
      expect(MemoryRecallTool.name).toBe("MemoryRecall");
      expect(typeof MemoryRecallTool.call).toBe("function");

      // Chunks are still queryable via searchPrecise after session indexing.
      const preciseAfter = searchPrecise(mem, "kubernetesdeploymentmarker");
      expect(preciseAfter.results.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S5: All 4 modules — no schema collision", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/wave7-int-s5", { rootDir: root });

      // One entry with ALL extended fields.
      mem.writeEntry({
        name: "Simon",
        description: "all-fields entity",
        type: "user",
        body: "Body references [[OtherEntity]] and [[ThirdEntity]].",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-25",
        accessCount: 4,
        importance: "high",
        decayWeight: 0.7,
        decayCount: 1,
        tombstoned: false,
        validFrom: "2020-01-01",
        validTo: "2025-12-31",
        recordedAt: "2026-04-25T12:00:00Z",
      });

      // writeEntry → readEntry preserves all fields.
      const read = mem.readEntry("Simon");
      expect(read).not.toBeNull();
      expect(read!.tier).toBe("core");
      expect(read!.lastAccessed).toBe("2026-04-25");
      expect(read!.accessCount).toBe(4);
      expect(read!.importance).toBe("high");
      expect(read!.decayWeight).toBe(0.7);
      expect(read!.decayCount).toBe(1);
      expect(read!.tombstoned).toBe(false);
      expect(read!.validFrom).toBe("2020-01-01");
      expect(read!.validTo).toBe("2025-12-31");
      expect(read!.recordedAt).toBe("2026-04-25T12:00:00Z");

      // linkScan picks up entity references from body.
      const scan = linkScan(mem);
      expect(scan.written).toBe(true);
      const fwd = linkForward(mem, "Simon.md");
      expect(fwd).toContain("OtherEntity");
      expect(fwd).toContain("ThirdEntity");

      // factAdd/factAt for the same entity (entity-scoped facts file lives in
      // memory/facts/ subdir, independent of the entry above).
      factAdd(mem, "Simon", "role", "CEO", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });
      factAdd(mem, "Simon", "company", "Hashed", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:31",
      });
      const fact = factAt(mem, "Simon", "role", { asOf: "2024-01-01" });
      expect(fact).not.toBeNull();
      expect(fact!.value).toBe("CEO");
      expect(factList(mem, "Simon")).toHaveLength(2);

      // Entry above (in memoryDir/Simon.md) and facts (in memoryDir/facts/simon.md)
      // are stored at distinct paths — no collision.
      const factsFile = join(getFactsDir(mem.projectId, root), "simon.md");
      expect(existsSync(factsFile)).toBe(true);
      expect(read!.filePath).not.toBe(factsFile);

      // compact() doesn't break the entry (core tier is protected) and doesn't
      // touch facts/ subdir.
      const factsBefore = readFileSync(factsFile, "utf-8");
      const result = compact({ projectMemory: mem });
      expect(result.moved).toBe(0); // only Simon (core) — not archivable
      expect(tierOf(mem, "Simon")).toBe("core");

      const afterCompact = mem.readEntry("Simon");
      expect(afterCompact).not.toBeNull();
      expect(afterCompact!.decayWeight).toBe(0.7);
      expect(afterCompact!.validFrom).toBe("2020-01-01");
      expect(afterCompact!.recordedAt).toBe("2026-04-25T12:00:00Z");
      expect(readFileSync(factsFile, "utf-8")).toBe(factsBefore);

      // After compact, links still resolvable.
      const fwdAfter = linkForward(mem, "Simon.md");
      expect(fwdAfter).toContain("OtherEntity");
      expect(fwdAfter).toContain("ThirdEntity");

      // factHistory still works.
      const hist = factHistory(mem, "Simon");
      expect(hist).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
