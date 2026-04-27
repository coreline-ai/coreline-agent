/**
 * Phase 8 — Cross-session recall (indexSession + searchRecall).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  indexSession,
  searchRecall,
} from "../src/memory/session-recall.js";
import { getSessionRecallDir } from "../src/config/paths.js";
import type { ChatMessage } from "../src/agent/types.js";

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-recall-test-"));
}

function mkUserMessage(text: string): ChatMessage {
  return { role: "user", content: text };
}

function mkAssistantMessage(text: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function daysAgoIso(days: number, now: number = Date.UTC(2026, 3, 25)): string {
  return new Date(now - days * 86_400_000).toISOString();
}

describe("Phase 8 — session-recall", () => {
  const projectId = "proj-recall";
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkTmpRoot();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("TC-8.1: Index session 'Bun migration discussion' matches query 'Bun migration' with score > 0.3", () => {
    const messages: ChatMessage[] = [
      mkUserMessage("Let's discuss the Bun migration plan for the coreline project."),
      mkAssistantMessage("Bun migration will require updating scripts, tsconfig, and test runner."),
    ];
    const indexedAt = new Date().toISOString();
    const res = indexSession({
      projectId,
      sessionId: "sess-bun-001",
      messages,
      indexedAt,
      rootDir,
    });
    expect(res.written).toBe(true);

    const search = searchRecall({
      projectId,
      query: "Bun migration",
      rootDir,
    });

    expect(search.results.length).toBe(1);
    const hit = search.results[0]!;
    expect(hit.sessionId).toBe("sess-bun-001");
    expect(hit.score).toBeGreaterThan(0.3);
    expect(hit.similarity).toBeGreaterThan(0.3);
    expect(search.counts.decisionsMatched).toBe(1);
    expect(search.counts.decisionsTotal).toBe(1);
  });

  test("TC-8.2: Session indexed 100 days ago excluded when timeRangeDays=90", () => {
    const now = Date.UTC(2026, 3, 25);
    const messages: ChatMessage[] = [
      mkUserMessage("Old discussion about Bun migration planning"),
      mkAssistantMessage("The migration needs careful review."),
    ];
    indexSession({
      projectId,
      sessionId: "sess-old",
      messages,
      indexedAt: daysAgoIso(100, now),
      rootDir,
    });

    const search = searchRecall({
      projectId,
      query: "Bun migration",
      timeRangeDays: 90,
      rootDir,
      now,
    });

    expect(search.results.length).toBe(0);
    expect(search.counts.skippedStale).toBe(1);
    expect(search.counts.decisionsMatched).toBe(0);
  });

  test("TC-8.3: Korean query 'ESLint 설정' matches Korean session content", () => {
    const messages: ChatMessage[] = [
      mkUserMessage("ESLint 설정 업데이트 관련 논의"),
      mkAssistantMessage("ESLint 설정 파일을 갱신했다."),
    ];
    indexSession({
      projectId,
      sessionId: "sess-ko",
      messages,
      rootDir,
    });

    const search = searchRecall({
      projectId,
      query: "ESLint 설정",
      rootDir,
    });

    expect(search.results.length).toBe(1);
    expect(search.results[0]!.sessionId).toBe("sess-ko");
    expect(search.results[0]!.similarity).toBeGreaterThan(0.5);
  });

  test("TC-8.4: minSimilarity=0.5 excludes low-similarity session", () => {
    const messages: ChatMessage[] = [
      mkUserMessage("Refactoring the parser module for new grammar tokens."),
      mkAssistantMessage("Parser refactor complete."),
    ];
    indexSession({
      projectId,
      sessionId: "sess-parser",
      messages,
      rootDir,
    });

    // Query overlaps only one token ("parser") out of many → similarity < 0.5
    const search = searchRecall({
      projectId,
      query: "parser database schema migration cluster deployment",
      minSimilarity: 0.5,
      rootDir,
    });

    expect(search.results.length).toBe(0);
    expect(search.counts.skippedLowSimilarity).toBe(1);
  });

  test("TC-8.5: maxResults=3 caps results", () => {
    const messages: ChatMessage[] = [
      mkUserMessage("Bun migration work item"),
      mkAssistantMessage("Bun migration is ongoing."),
    ];
    for (let i = 0; i < 7; i += 1) {
      indexSession({
        projectId,
        sessionId: `sess-bun-${i}`,
        messages,
        indexedAt: new Date(Date.UTC(2026, 3, 1 + i)).toISOString(),
        rootDir,
      });
    }

    const search = searchRecall({
      projectId,
      query: "Bun migration",
      maxResults: 3,
      rootDir,
    });

    expect(search.results.length).toBe(3);
    expect(search.counts.decisionsMatched).toBe(7);
  });

  test("TC-8.6: Equal scores sorted by indexedAt desc", () => {
    const messages: ChatMessage[] = [
      mkUserMessage("Bun migration alpha"),
      mkAssistantMessage("Bun migration alpha confirmed."),
    ];
    const now = Date.UTC(2026, 3, 25);
    // All indexed on same day → same ageDays → equal recencyWeight.
    // Same tokens → equal similarity → equal score. indexedAt differs by seconds.
    indexSession({
      projectId,
      sessionId: "sess-a",
      messages,
      indexedAt: new Date(now - 2 * 3600_000).toISOString(),
      rootDir,
    });
    indexSession({
      projectId,
      sessionId: "sess-b",
      messages,
      indexedAt: new Date(now - 1 * 3600_000).toISOString(),
      rootDir,
    });
    indexSession({
      projectId,
      sessionId: "sess-c",
      messages,
      indexedAt: new Date(now - 3 * 3600_000).toISOString(),
      rootDir,
    });

    const search = searchRecall({
      projectId,
      query: "Bun migration alpha",
      rootDir,
      now,
    });

    expect(search.results.length).toBe(3);
    // Equal scores → indexedAt desc order: b (1h), a (2h), c (3h)
    expect(search.results[0]!.sessionId).toBe("sess-b");
    expect(search.results[1]!.sessionId).toBe("sess-a");
    expect(search.results[2]!.sessionId).toBe("sess-c");
  });

  test("TC-8.7: Empty index directory returns empty result with zero counts", () => {
    const search = searchRecall({
      projectId,
      query: "anything",
      rootDir,
    });

    expect(search.results).toEqual([]);
    expect(search.counts.decisionsMatched).toBe(0);
    expect(search.counts.decisionsTotal).toBe(0);
    expect(search.counts.skippedStale).toBe(0);
    expect(search.counts.skippedLowSimilarity).toBe(0);
    expect(search.counts.skippedCorrupt).toBe(0);
    expect(search.query).toBe("anything");
  });

  test("TC-8.E1: Corrupt JSON file is skipped silently; other sessions returned", () => {
    // First index a valid session.
    indexSession({
      projectId,
      sessionId: "sess-valid",
      messages: [
        mkUserMessage("Bun migration discussion details"),
        mkAssistantMessage("Bun migration is planned."),
      ],
      rootDir,
    });

    // Drop a corrupt file alongside.
    const dir = getSessionRecallDir(projectId, rootDir);
    writeFileSync(join(dir, "corrupt.json"), "{not valid json", "utf8");
    // Also add a file with wrong shape.
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ foo: "bar" }), "utf8");

    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(3);

    const search = searchRecall({
      projectId,
      query: "Bun migration",
      rootDir,
    });

    expect(search.results.length).toBe(1);
    expect(search.results[0]!.sessionId).toBe("sess-valid");
    expect(search.counts.skippedCorrupt).toBeGreaterThanOrEqual(2);
    expect(search.counts.decisionsTotal).toBe(1);
  });
});
