/**
 * Phase 14 (MemKraft Integration) — E2E integration smoke test.
 *
 * Exercises the full cross-module stack (memory tiers, working set,
 * compaction, promotion, evidence, eval summary, session recall,
 * convergence, digest) against a real on-disk ProjectMemory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProjectMemory } from "../src/memory/project-memory.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { compact } from "../src/memory/compaction.js";
import { promoteByAccessCount } from "../src/memory/auto-promote.js";
import { renderDigest } from "../src/memory/digest.js";
import { indexSession, searchRecall } from "../src/memory/session-recall.js";
import { appendEvidence, readEvidence } from "../src/agent/self-improve/evidence.js";
import { summariseEval } from "../src/agent/self-improve/eval.js";
import { checkConvergence } from "../src/agent/self-improve/convergence.js";
import { tierOf } from "../src/memory/tiering.js";
import type { LLMProvider } from "../src/providers/types.js";
import type { EvidenceRecord } from "../src/agent/self-improve/types.js";

function createMockProvider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send() {
      return;
    },
  };
}

function isoDaysAgo(days: number): string {
  const t = Date.now() - days * 86_400_000;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("MemKraft Integration — E2E smoke (Phase 14)", () => {
  let rootDir: string;
  let workspace: string;
  let projectMemory: ProjectMemory;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "memkraft-smoke-root-"));
    workspace = mkdtempSync(join(tmpdir(), "memkraft-smoke-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Rules\nPrefer Bun.");
    projectMemory = new ProjectMemory(workspace, { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TC-14.1: Core/recall entries surface through buildSystemPrompt working set.
  // -------------------------------------------------------------------------
  test("TC-14.1: system prompt injects core + recall working-set items", () => {
    const today = isoDaysAgo(0);

    // 3 user (core), 1 feedback (core), 1 reference (recall) = 4 core + 1 recall
    projectMemory.writeEntry({
      name: "user_rule_1",
      description: "prefer bun",
      type: "user",
      body: "Prefer Bun runtime.",
      filePath: "",
      tier: "core",
      lastAccessed: today,
      accessCount: 1,
    });
    projectMemory.writeEntry({
      name: "user_rule_2",
      description: "style guide",
      type: "user",
      body: "Two-space indent.",
      filePath: "",
      tier: "core",
      lastAccessed: today,
      accessCount: 1,
    });
    projectMemory.writeEntry({
      name: "user_rule_3",
      description: "test runner",
      type: "user",
      body: "bun test for everything.",
      filePath: "",
      tier: "core",
      lastAccessed: today,
      accessCount: 1,
    });
    projectMemory.writeEntry({
      name: "feedback_1",
      description: "prefer concise commits",
      type: "feedback",
      body: "Commit messages stay under 72 chars.",
      filePath: "",
      tier: "core",
      lastAccessed: today,
      accessCount: 1,
    });
    projectMemory.writeEntry({
      name: "reference_1",
      description: "mcp docs link",
      type: "reference",
      body: "See docs/mcp-ops.md.",
      filePath: "",
      tier: "recall",
      lastAccessed: today,
      accessCount: 1,
    });

    const prompt = buildSystemPrompt(workspace, [], projectMemory, createMockProvider());

    // 4 core + 1 recall surface; archival count = 0.
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("user_rule_1");
    expect(prompt).toContain("user_rule_2");
    expect(prompt).toContain("user_rule_3");
    expect(prompt).toContain("feedback_1");
    expect(prompt).toContain("reference_1");
  });

  // -------------------------------------------------------------------------
  // TC-14.2: compaction moves old/low-importance entries to archival.
  // -------------------------------------------------------------------------
  test("TC-14.2: compaction moves 35+ day stale entries to archival", () => {
    const stale = isoDaysAgo(40);

    projectMemory.writeEntry({
      name: "old_low",
      description: "low importance stale",
      type: "reference",
      body: "stale note.",
      filePath: "",
      tier: "recall",
      lastAccessed: stale,
      accessCount: 0,
      importance: "low",
    });
    projectMemory.writeEntry({
      name: "fresh_core",
      description: "fresh core entry",
      type: "user",
      body: "still relevant.",
      filePath: "",
      tier: "core",
      lastAccessed: isoDaysAgo(0),
      accessCount: 5,
    });

    const result = compact({ projectMemory, maxChars: 100 });

    expect(result.moved).toBeGreaterThanOrEqual(1);
    expect(result.movedNames).toContain("old_low");
    expect(tierOf(projectMemory, "old_low")).toBe("archival");
    // core entry stays untouched.
    expect(tierOf(projectMemory, "fresh_core")).toBe("core");
  });

  // -------------------------------------------------------------------------
  // TC-14.3: summariseEval over 5 skill evidence records.
  // -------------------------------------------------------------------------
  test("TC-14.3: summariseEval aggregates 5 skill records", () => {
    const projectId = projectMemory.projectId;
    const baseTs = new Date().toISOString();

    for (let i = 1; i <= 5; i += 1) {
      const record: EvidenceRecord = {
        domain: "skill",
        id: "dev-plan",
        sessionId: `s-${i}`,
        iteration: i,
        invokedAt: baseTs,
        outcome: {
          success: i !== 3, // 4 pass, 1 fail
          accuracy: 80 + i,
          toolCalls: 5,
          durationMs: 1000,
        },
      };
      const r = appendEvidence(projectId, record, rootDir);
      expect(r.recorded).toBe(true);
    }

    const records = readEvidence(projectId, "skill", "dev-plan", {}, rootDir);
    expect(records.length).toBe(5);

    const summary = summariseEval(records);
    expect(summary.total).toBe(5);
    expect(summary.passed).toBe(4);
    expect(summary.failed).toBe(1);
    expect(summary.passRate).toBe(80);
  });

  // -------------------------------------------------------------------------
  // TC-14.4: indexSession + searchRecall with timeRange filter.
  // -------------------------------------------------------------------------
  test("TC-14.4: searchRecall filters sessions outside timeRangeDays", () => {
    const projectId = projectMemory.projectId;
    const now = Date.now();
    const oldIso = new Date(now - 91 * 86_400_000).toISOString();
    const todayIso = new Date(now).toISOString();

    const oldResult = indexSession({
      projectId,
      sessionId: "old-session",
      messages: [
        { role: "user", content: "migrate build pipeline to bun" },
        { role: "assistant", content: "migrated pipeline configuration to bun" },
      ],
      indexedAt: oldIso,
      rootDir,
    });
    expect(oldResult.written).toBe(true);

    const freshResult = indexSession({
      projectId,
      sessionId: "fresh-session",
      messages: [
        { role: "user", content: "migrate build pipeline to bun" },
        { role: "assistant", content: "updated pipeline script today" },
      ],
      indexedAt: todayIso,
      rootDir,
    });
    expect(freshResult.written).toBe(true);

    const search = searchRecall({
      projectId,
      query: "migrate build pipeline bun",
      timeRangeDays: 30,
      rootDir,
      now,
    });

    const ids = search.results.map((r) => r.sessionId);
    expect(ids).toContain("fresh-session");
    expect(ids).not.toContain("old-session");
  });

  // -------------------------------------------------------------------------
  // TC-14.5: checkConvergence — 3 identical successful iterations → converged.
  // -------------------------------------------------------------------------
  test("TC-14.5: checkConvergence returns converged for stable records", () => {
    const baseTs = new Date().toISOString();
    const records: EvidenceRecord[] = [1, 2, 3].map((i) => ({
      domain: "plan-iteration",
      id: "plan-abc",
      sessionId: `s-${i}`,
      iteration: i,
      invokedAt: baseTs,
      outcome: {
        success: true,
        accuracy: 95,
        toolCalls: 10,
        durationMs: 2000,
      },
    }));

    const verdict = checkConvergence({ records, window: 3 });
    expect(verdict.converged).toBe(true);
    expect(verdict.reason).toBe("converged");
    expect(verdict.suggestedNext).toBe("stop");
  });

  // -------------------------------------------------------------------------
  // TC-14.6: promoteByAccessCount moves recall→core when count >= threshold.
  // -------------------------------------------------------------------------
  test("TC-14.6: promoteByAccessCount promotes hot recall entries to core", () => {
    projectMemory.writeEntry({
      name: "hot_recall",
      description: "frequently used reference",
      type: "reference",
      body: "keeps coming up.",
      filePath: "",
      tier: "recall",
      lastAccessed: isoDaysAgo(0),
      accessCount: 3,
    });

    const result = promoteByAccessCount({ projectMemory });
    expect(result.promoted).toBe(1);
    expect(result.promotedNames).toContain("hot_recall");
    expect(tierOf(projectMemory, "hot_recall")).toBe("core");
  });

  // -------------------------------------------------------------------------
  // TC-14.7: renderDigest produces all three tier section headers.
  // -------------------------------------------------------------------------
  test("TC-14.7: renderDigest emits core + recall + archival section headers", () => {
    const today = isoDaysAgo(0);

    projectMemory.writeEntry({
      name: "core_a",
      description: "core entry",
      type: "user",
      body: "c",
      filePath: "",
      tier: "core",
      lastAccessed: today,
      accessCount: 1,
    });
    projectMemory.writeEntry({
      name: "recall_a",
      description: "recent recall",
      type: "reference",
      body: "r",
      filePath: "",
      tier: "recall",
      lastAccessed: today,
      accessCount: 1,
    });
    projectMemory.writeEntry({
      name: "archival_a",
      description: "archived entry",
      type: "reference",
      body: "a",
      filePath: "",
      tier: "archival",
      lastAccessed: isoDaysAgo(200),
      accessCount: 0,
    });

    const result = renderDigest({ projectMemory });
    expect(result.coreCount).toBe(1);
    expect(result.recallRecentCount).toBe(1);
    expect(result.archivalCount).toBe(1);
    expect(result.content).toContain("🔴 Core Memory");
    expect(result.content).toContain("🟡 Recent Memory");
    expect(result.content).toContain("🔵 Archived");
  });
});
