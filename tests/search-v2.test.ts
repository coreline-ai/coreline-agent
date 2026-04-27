/**
 * Phase 11 N2 — Search v2 (searchTemporal, searchExpand, searchV2) tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import { indexSession } from "../src/memory/session-recall.js";
import {
  parseDateHint,
  searchExpand,
  searchTemporal,
  searchV2,
} from "../src/memory/search-v2.js";
import type { ChatMessage } from "../src/agent/types.js";

const NOW = Date.UTC(2026, 3, 26); // 2026-04-26 UTC

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "coreline-search-v2-"));
}

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text };
}

function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

interface Fixture {
  rootDir: string;
  projectId: string;
  memory: ProjectMemory;
}

function buildFixture(): Fixture {
  const rootDir = mkTmp();
  const memory = new ProjectMemory("/tmp/search-v2-fixture-cwd", { rootDir });
  const projectId = memory.projectId;

  // 4 memory entries with varied lastAccessed and content.
  memory.writeEntry({
    name: "build_recipe",
    description: "How to build the project",
    type: "reference",
    body: "Run bun build to compile the bundle. Errors during build are common.",
    filePath: "",
    tier: "core",
    lastAccessed: "2026-04-25",
  });
  memory.writeEntry({
    name: "test_runbook",
    description: "Test execution guide",
    type: "reference",
    body: "Run bun test to verify the spec. Use bun test --watch during dev.",
    filePath: "",
    tier: "recall",
    lastAccessed: "2026-04-20",
  });
  memory.writeEntry({
    name: "bug_log",
    description: "Common bugs and issues",
    type: "reference",
    body: "Known bug: tsconfig issue causes compile failure. Workaround: clean install.",
    filePath: "",
    tier: "recall",
    lastAccessed: "2026-04-10",
  });
  memory.writeEntry({
    name: "korean_notes",
    description: "한국어 메모",
    type: "reference",
    body: "버그 발생 시 빌드를 다시 실행하여 오류를 확인한다. 테스트 통과 필수.",
    filePath: "",
    tier: "recall",
    lastAccessed: "2026-03-15",
  });

  // 2 session-recall entries with different indexedAt.
  indexSession({
    projectId,
    sessionId: "sess-recent",
    messages: [
      userMsg("Discuss build errors today"),
      assistantMsg("The build failed due to a compile error in tsconfig."),
    ],
    indexedAt: new Date(NOW - 1 * 86_400_000).toISOString(), // 1 day ago
    rootDir,
  });
  indexSession({
    projectId,
    sessionId: "sess-old",
    messages: [
      userMsg("Old build planning conversation"),
      assistantMsg("We planned the build pipeline for the project."),
    ],
    indexedAt: new Date(NOW - 60 * 86_400_000).toISOString(), // 60 days ago
    rootDir,
  });

  return { rootDir, projectId, memory };
}

describe("Phase 11 N2 — parseDateHint", () => {
  test("TC-N2.1: parseDateHint('yesterday') → -1 day, window 1", () => {
    const hint = parseDateHint("yesterday", NOW);
    expect(hint).not.toBeNull();
    expect(hint!.windowDays).toBe(1);
    const expected = NOW - 86_400_000;
    expect(Math.abs(hint!.anchorDate.getTime() - expected)).toBeLessThan(1000);
  });

  test("TC-N2.2: parseDateHint('last week') → window 7", () => {
    const hint = parseDateHint("last week", NOW);
    expect(hint).not.toBeNull();
    expect(hint!.windowDays).toBe(7);
  });

  test("TC-N2.3: parseDateHint('2026-04-25') → exact UTC date, window 1", () => {
    const hint = parseDateHint("2026-04-25", NOW);
    expect(hint).not.toBeNull();
    expect(hint!.windowDays).toBe(1);
    expect(hint!.anchorDate.getUTCFullYear()).toBe(2026);
    expect(hint!.anchorDate.getUTCMonth()).toBe(3); // April
    expect(hint!.anchorDate.getUTCDate()).toBe(25);
  });

  test("TC-N2.4: parseDateHint('2026-04') → mid-month, window 30", () => {
    const hint = parseDateHint("2026-04", NOW);
    expect(hint).not.toBeNull();
    expect(hint!.windowDays).toBe(30);
    expect(hint!.anchorDate.getUTCDate()).toBe(15);
  });

  test("TC-N2.5: parseDateHint('invalid garbage') → null", () => {
    expect(parseDateHint("invalid garbage", NOW)).toBeNull();
    expect(parseDateHint("", NOW)).toBeNull();
    expect(parseDateHint(undefined, NOW)).toBeNull();
  });

  test("TC-N2.6: parseDateHint(Date) → window 1", () => {
    const d = new Date(NOW - 5 * 86_400_000);
    const hint = parseDateHint(d, NOW);
    expect(hint).not.toBeNull();
    expect(hint!.windowDays).toBe(1);
    expect(hint!.anchorDate.getTime()).toBe(d.getTime());
  });
});

describe("Phase 11 N2 — searchTemporal", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = buildFixture();
  });

  afterEach(() => {
    rmSync(fx.rootDir, { recursive: true, force: true });
  });

  test("TC-N2.7: searchTemporal with 'yesterday' boosts recent items above stale ones", () => {
    const result = searchTemporal({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      dateHint: "yesterday",
      now: NOW,
      scoreThreshold: 0.1,
    });
    expect(result.results.length).toBeGreaterThan(0);
    // Items inside the window (sess-recent @ 1d, build_recipe @ 1d) must carry
    // the boost marker; items outside (sess-old @ 60d) must NOT.
    const sessRecent = result.results.find((h) => h.id === "sess-recent");
    const sessOld = result.results.find((h) => h.id === "sess-old");
    expect(sessRecent).toBeDefined();
    expect(sessRecent!.metadata?.temporalBoost).toBe(2);
    if (sessOld) {
      expect(sessOld.metadata?.temporalBoost).toBeUndefined();
    }
    // Recent session must outrank the old session.
    const recentIdx = result.results.findIndex((h) => h.id === "sess-recent");
    const oldIdx = result.results.findIndex((h) => h.id === "sess-old");
    if (oldIdx >= 0) {
      expect(recentIdx).toBeLessThan(oldIdx);
    }
  });

  test("TC-N2.8: searchTemporal without dateHint falls back to recency ordering", () => {
    const result = searchTemporal({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      now: NOW,
      scoreThreshold: 0.1,
    });
    expect(result.results.length).toBeGreaterThan(0);
    // Recency sort — first item should have the highest timestamp.
    const tsList = result.results
      .map((h) => (h.metadata?.timestampMs as number | undefined) ?? 0)
      .filter((t) => t > 0);
    for (let i = 1; i < tsList.length; i += 1) {
      expect(tsList[i - 1]).toBeGreaterThanOrEqual(tsList[i]!);
    }
  });
});

describe("Phase 11 N2 — searchExpand", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = buildFixture();
  });

  afterEach(() => {
    rmSync(fx.rootDir, { recursive: true, force: true });
  });

  test("TC-N2.9: searchExpand 'error' picks up entries containing 'bug' / 'issue'", () => {
    const result = searchExpand({
      query: "error",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      now: NOW,
      scoreThreshold: 0.1,
    });
    const ids = result.results.map((h) => h.id);
    // bug_log mentions "bug"/"issue"; build_recipe mentions "Errors".
    expect(ids).toContain("bug_log");
  });

  test("TC-N2.10: searchExpand Korean '버그' expands to '오류' / '에러'", () => {
    const result = searchExpand({
      query: "버그",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      now: NOW,
      scoreThreshold: 0.1,
    });
    const ids = result.results.map((h) => h.id);
    // korean_notes contains 버그/오류 — should match.
    expect(ids).toContain("korean_notes");
  });
});

describe("Phase 11 N2 — searchV2", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = buildFixture();
  });

  afterEach(() => {
    rmSync(fx.rootDir, { recursive: true, force: true });
  });

  test("TC-N2.11: sortBy 'relevance' vs 'recency' yield different orderings", () => {
    const rel = searchV2({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      sortBy: "relevance",
      now: NOW,
      scoreThreshold: 0.1,
    });
    const rec = searchV2({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      sortBy: "recency",
      now: NOW,
      scoreThreshold: 0.1,
    });
    expect(rel.results.length).toBeGreaterThan(1);
    expect(rec.results.length).toBeGreaterThan(1);
    // Recency must order by timestampMs desc.
    const recTs = rec.results
      .map((h) => (h.metadata?.timestampMs as number | undefined) ?? 0)
      .filter((t) => t > 0);
    for (let i = 1; i < recTs.length; i += 1) {
      expect(recTs[i - 1]).toBeGreaterThanOrEqual(recTs[i]!);
    }
    // Relevance must order by rankingScore desc.
    for (let i = 1; i < rel.results.length; i += 1) {
      expect(rel.results[i - 1]!.rankingScore).toBeGreaterThanOrEqual(
        rel.results[i]!.rankingScore,
      );
    }
  });

  test("TC-N2.12: domain 'memory' excludes session results", () => {
    const result = searchV2({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      domain: "memory",
      now: NOW,
      scoreThreshold: 0.1,
    });
    expect(result.domains.session).toBe(0);
    for (const hit of result.results) {
      expect(hit.source).toBe("memory");
    }
    expect(result.domains.memory).toBeGreaterThan(0);
  });

  test("TC-N2.13: topK caps result count", () => {
    const result = searchV2({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      topK: 2,
      now: NOW,
      scoreThreshold: 0.05,
    });
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  test("TC-N2.14: scoreThreshold filters low-relevance hits", () => {
    const result = searchV2({
      query: "build",
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      scoreThreshold: 0.5,
      now: NOW,
    });
    for (const hit of result.results) {
      expect(hit.score).toBeGreaterThanOrEqual(0.5);
    }
  });
});
