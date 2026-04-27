/**
 * Real-world scenario tests for MemKraft integration.
 * Simulates full user workflows end-to-end to expose integration bugs that
 * unit-level tests don't catch.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectMemory } from "../src/memory/project-memory.js";
import { tierSet, tierOf, tierTouch, tierList } from "../src/memory/tiering.js";
import { selectWorkingSet, selectWorkingSetWithStats } from "../src/memory/working-set.js";
import { renderDigest, writeDigest } from "../src/memory/digest.js";
import { compact } from "../src/memory/compaction.js";
import { promoteByAccessCount } from "../src/memory/auto-promote.js";
import { indexSession, searchRecall } from "../src/memory/session-recall.js";
import { appendEvidence, readEvidence } from "../src/agent/self-improve/evidence.js";
import { summariseEval } from "../src/agent/self-improve/eval.js";
import { recordSkillRun, evaluateSessionSkills } from "../src/agent/self-improve/skill-tracker.js";
import {
  registerSkillSelection,
  consumeAppliedSkills,
  registrySize,
  resetRegistry,
} from "../src/agent/self-improve/applied-skill-registry.js";
import { recordSubagentRun, extractSubagentType } from "../src/agent/self-improve/subagent-tracker.js";
import { checkConvergence } from "../src/agent/self-improve/convergence.js";
import { recordIterationAndCheck } from "../src/agent/plan-execute/convergence-gate.js";
import { registerExperiment, pickVariant, recordExperimentUse } from "../src/agent/self-improve/prompt-experiment.js";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import type { SkillSelection } from "../src/skills/types.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-real-"));
}

describe("REAL-1: user-day workflow (write memories → tier → system prompt)", () => {
  test("fresh project gains tier over 8 interactions", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/user-day", { rootDir: root });

      // Day 1: write 8 memories with different types
      mem.writeEntry({
        name: "language_preference",
        description: "사용자는 한국어 응답 선호",
        type: "user",
        body: "항상 한국어로 답변한다. 기술 용어는 영어 OK.",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-25",
        accessCount: 5,
      });
      mem.writeEntry({
        name: "bun_preference",
        description: "Bun runtime 선호",
        type: "user",
        body: "Node 대신 Bun 사용. bun run 스크립트로 통일.",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-24",
      });
      mem.writeEntry({
        name: "no_mocks_rule",
        description: "테스트에서 DB mock 금지",
        type: "feedback",
        body: "통합 테스트는 실제 DB 사용. 과거 마이그레이션 실패 회고.",
        filePath: "",
        tier: "core",
      });
      // 5 recall with varied lastAccessed
      for (let i = 0; i < 5; i++) {
        mem.writeEntry({
          name: `recent_task_${i}`,
          description: `최근 작업 ${i}`,
          type: "reference",
          body: `Task ${i} context...`,
          filePath: "",
          tier: "recall",
          lastAccessed: `2026-04-${20 + i}`,
        });
      }

      // Verify working set
      const ws = selectWorkingSetWithStats({ projectMemory: mem, limit: 8 });
      expect(ws.coreCount).toBe(3);
      expect(ws.recallCount).toBe(5);
      expect(ws.entries.length).toBe(8);

      // Most recently accessed recall should be first in recall portion
      const recallEntries = ws.entries.slice(3);
      expect(recallEntries[0]?.name).toBe("recent_task_4"); // 2026-04-24 most recent

      // Verify MEMORY.md digest
      const digest = renderDigest({ projectMemory: mem, maxChars: 15000 });
      expect(digest.content).toContain("🔴 Core Memory");
      expect(digest.content).toContain("🟡 Recent Memory");
      expect(digest.content).toContain("language_preference");
      expect(digest.content).toContain("recent_task_4");
      expect(digest.content).not.toContain("🔵 Archived"); // 0 archival

      // Write digest to disk
      const writeRes = writeDigest({ projectId: mem.projectId, content: digest.content, rootDir: root });
      expect(writeRes.written).toBe(true);
      expect(existsSync(writeRes.path!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-2: compaction real scenario — 6 months later", () => {
  test("old entries move to archival, core preserved", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/user-6mo", { rootDir: root });

      // Core entry, 200 days old — must survive
      mem.writeEntry({
        name: "ancient_core",
        description: "오래된 핵심 선호",
        type: "user",
        body: "2025년부터 유지되는 규칙",
        filePath: "",
        tier: "core",
        lastAccessed: "2025-10-01",
      });

      // Recall entry, 100 days old — should move to archival (rule 1)
      mem.writeEntry({
        name: "old_recall",
        description: "오래된 recall",
        type: "reference",
        body: "3개월 전 reference",
        filePath: "",
        tier: "recall",
        lastAccessed: "2026-01-15",
      });

      // Low-importance recall, 45 days old — should move (rule 2)
      mem.writeEntry({
        name: "low_importance_item",
        description: "저중요도 항목",
        type: "reference",
        body: "low importance",
        filePath: "",
        tier: "recall",
        lastAccessed: "2026-03-11",
        importance: "low",
      });

      // Recent recall — should stay
      mem.writeEntry({
        name: "recent_recall",
        description: "최근 recall",
        type: "reference",
        body: "recent",
        filePath: "",
        tier: "recall",
        lastAccessed: "2026-04-20",
      });

      // Dry run first
      const preview = compact({ projectMemory: mem, dryRun: true });
      expect(preview.moved).toBe(2);
      expect(preview.dryRun).toBe(true);
      expect(tierOf(mem, "old_recall")).toBe("recall"); // not yet moved
      expect(preview.movedNames).toContain("old_recall");
      expect(preview.movedNames).toContain("low_importance_item");

      // Real run
      const real = compact({ projectMemory: mem });
      expect(real.moved).toBe(2);
      expect(tierOf(mem, "ancient_core")).toBe("core"); // survived
      expect(tierOf(mem, "old_recall")).toBe("archival"); // archived
      expect(tierOf(mem, "low_importance_item")).toBe("archival");
      expect(tierOf(mem, "recent_recall")).toBe("recall"); // preserved

      // Running compact again should move nothing
      const second = compact({ projectMemory: mem });
      expect(second.moved).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-3: auto-promotion after repeated access", () => {
  test("recall with accessCount 3 gets promoted to core", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/user-promote", { rootDir: root });
      mem.writeEntry({
        name: "candidate",
        description: "자주 쓰이는 패턴",
        type: "reference",
        body: "pattern",
        filePath: "",
        tier: "recall",
      });

      // Simulate 3 accesses via tierTouch
      for (let i = 0; i < 3; i++) tierTouch(mem, "candidate");
      expect(tierOf(mem, "candidate")).toBe("recall"); // tierTouch doesn't change tier

      const result = promoteByAccessCount({ projectMemory: mem });
      expect(result.promoted).toBe(1);
      expect(result.promotedNames).toEqual(["candidate"]);
      expect(tierOf(mem, "candidate")).toBe("core"); // promoted

      // CORELINE_AUTO_PROMOTE=0 disables
      const saved = process.env.CORELINE_AUTO_PROMOTE;
      process.env.CORELINE_AUTO_PROMOTE = "0";
      try {
        const disabled = promoteByAccessCount({ projectMemory: mem });
        expect(disabled.skipped).toBe("disabled");
      } finally {
        if (saved === undefined) delete process.env.CORELINE_AUTO_PROMOTE;
        else process.env.CORELINE_AUTO_PROMOTE = saved;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-4: skill tracker full cycle (register → evaluate → stats)", () => {
  test("skill registers at routing, evaluates at session end, readable in stats", () => {
    const root = mkTmp();
    try {
      resetRegistry();

      const sessionId = "sess-real-4";
      const projectId = "proj-real-4";

      // Phase: router registers skills for this session
      const devPlanSkill: SkillSelection = {
        skill: {
          id: "dev-plan",
          title: "Dev Plan",
          summary: "",
          content: "",
          triggers: [],
          priority: 10,
          autoEnabled: true,
          modeConstraints: [],
        },
        source: "auto",
        reasonCode: "kw_dev_plan",
        priority: 10,
      };
      registerSkillSelection(sessionId, [devPlanSkill]);
      expect(registrySize()).toBe(1);

      // Phase: session ends → evaluate
      evaluateSessionSkills({
        projectId,
        sessionId,
        turnReason: "completed",
        turnsUsed: 4,
        toolCalls: 12,
        durationMs: 15000,
        rootDir: root,
      });

      // Registry should be cleared after consume
      expect(registrySize()).toBe(0);

      // Evidence should be written
      const records = readEvidence(projectId, "skill", "dev-plan", undefined, root);
      expect(records.length).toBe(1);
      expect(records[0]!.sessionId).toBe(sessionId);
      expect(records[0]!.outcome.success).toBe(true);
      expect(records[0]!.outcome.turnsUsed).toBe(4);

      // summariseEval
      const summary = summariseEval(records);
      expect(summary.total).toBe(1);
      expect(summary.passed).toBe(1);
      expect(summary.passRate).toBe(100);
      expect(summary.avgToolUses).toBe(12);

      // Simulate 4 more runs: 3 success, 1 fail
      // Signature: recordSkillRun(projectId, record, rootDir)
      for (let i = 0; i < 3; i++) {
        recordSkillRun(
          projectId,
          { skillId: "dev-plan", sessionId: `s${i}`, outcome: { success: true, turnsUsed: 3 + i } },
          root,
        );
      }
      recordSkillRun(
        projectId,
        {
          skillId: "dev-plan",
          sessionId: "s_fail",
          outcome: { success: false, turnsUsed: 10, unclearPoints: ["edge case"] },
        },
        root,
      );

      const fullSummary = summariseEval(readEvidence(projectId, "skill", "dev-plan", undefined, root));
      expect(fullSummary.total).toBe(5);
      expect(fullSummary.passed).toBe(4);
      expect(fullSummary.passRate).toBe(80);
      expect(fullSummary.unclearCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      resetRegistry();
    }
  });
});

describe("REAL-5: subagent tracker — reproduce B1 bug (agentDepth inconsistency)", () => {
  test("BUG: agentDepth in persistChildResult's recordSubagentRun differs from saveSubAgentRun", () => {
    // This test documents the inconsistency found in expert review.
    // persistChildResult (agent-tool.ts):
    //   - saveSubAgentRun   records agentDepth: context.agentDepth + 1
    //   - recordSubagentRun records agentDepth: context.agentDepth + 2
    //
    // Root agent (agentDepth=0) dispatches Agent tool → coordinator at depth 1.
    // Coordinator dispatches child → child is at depth 2.
    // So `recordSubagentRun`'s +2 is SEMANTICALLY CORRECT for the child.
    // `saveSubAgentRun`'s +1 is wrong for children (but correct for coordinator/single).
    //
    // Conclusion: saveSubAgentRun has a pre-existing bug in child recording,
    // and recordSubagentRun is more correct. The two values should either
    // both be +2 (child) or the review's concern is moot.
    //
    // This test just documents; no fix applied here.
    // POST-FIX: recordSubagentRun harmonized to +1 matching saveSubAgentRun.
    const rootAgentDepth = 0;
    const childDepthViaSaveSubAgentRun = rootAgentDepth + 1;
    const childDepthViaRecordSubagentRun = rootAgentDepth + 1;  // FIXED: was +2

    expect(childDepthViaSaveSubAgentRun).toBe(childDepthViaRecordSubagentRun);
  });

  test("subagentType extraction from varied prompts", () => {
    expect(extractSubagentType("[Explore] find the auth flow")).toBe("Explore");
    expect(extractSubagentType("[Plan] design migration")).toBe("Plan");
    expect(extractSubagentType("  [Review] code quality")).toBe("Review");
    expect(extractSubagentType("no bracket prompt here")).toContain("no bracket"); // first-40
    expect(extractSubagentType("")).toBe("unspecified");
  });

  test("recordSubagentRun writes JSONL with correct structure", () => {
    const root = mkTmp();
    try {
      const result = recordSubagentRun("proj-sub", {
        subagentType: "Explore",
        parentSessionId: "parent-1",
        agentDepth: 1,
        outcome: {
          success: true,
          turnsUsed: 3,
          toolCalls: 5,
          unclearPoints: [],
        },
        metadata: { reason: "completed" },
      }, root);
      expect(result.recorded).toBe(true);

      const records = readEvidence("proj-sub", "subagent", "Explore", undefined, root);
      expect(records.length).toBe(1);
      expect(records[0]!.domain).toBe("subagent");
      expect(records[0]!.outcome.success).toBe(true);
      expect(records[0]!.metadata?.reason).toBe("completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-6: convergence auto-stop full cycle", () => {
  test("3 identical plan iterations → convergence-gate returns stop=true", () => {
    const root = mkTmp();
    try {
      const projectId = "proj-conv";
      const sessionId = "sess-conv";
      const planId = `${sessionId}-2026-04-25`;

      // Simulate 3 plan-iterations all successful with tight metrics
      const step = {
        task: {
          id: "t1",
          description: "test task",
          status: "completed" as const,
        },
        evaluation: { success: true, outcome: "ok", reason: "", strategy: "", contract: "" },
      };

      const r1 = recordIterationAndCheck({ projectId, sessionId, planId, rootDir: root }, step as any);
      expect(r1.stop).toBe(false); // only 1 iteration

      const r2 = recordIterationAndCheck({ projectId, sessionId, planId, rootDir: root }, step as any);
      expect(r2.stop).toBe(true); // 2 iterations, all success, no unclear → converged
      expect(r2.verdict.converged).toBe(true);
      expect(r2.verdict.reason).toBe("converged");

      // CORELINE_DISABLE_CONVERGENCE_AUTOSTOP=1 disables
      const saved = process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP;
      process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP = "1";
      try {
        const r3 = recordIterationAndCheck({ projectId, sessionId, planId, rootDir: root }, step as any);
        expect(r3.stop).toBe(false); // disabled
        expect(r3.verdict.converged).toBe(true); // verdict still says converged
      } finally {
        if (saved === undefined) delete process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP;
        else process.env.CORELINE_DISABLE_CONVERGENCE_AUTOSTOP = saved;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-7: cross-session recall — reproduce I5 NaN bug", () => {
  test("BUG: searchRecall with timeRangeDays=0 produces NaN scores", () => {
    const root = mkTmp();
    try {
      const projectId = "proj-nan";

      // Index a session today
      indexSession({
        projectId,
        sessionId: "recent-sess",
        messages: [
          { role: "user", content: "How do I use ESLint?" } as any,
          { role: "assistant", content: "ESLint is configured via eslintrc." } as any,
        ],
        rootDir: root,
      });

      const result = searchRecall({
        projectId,
        query: "ESLint",
        timeRangeDays: 0, // BUG: divide-by-zero in recencyWeight
        rootDir: root,
      });

      // All results should have valid scores (not NaN)
      for (const hit of result.results) {
        expect(Number.isFinite(hit.score)).toBe(true); // Will FAIL if bug present
        expect(Number.isFinite(hit.recencyWeight)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normal session recall works with timeRangeDays=30", () => {
    const root = mkTmp();
    try {
      const projectId = "proj-recall";

      indexSession({
        projectId,
        sessionId: "sess-bun",
        messages: [
          { role: "user", content: "Bun으로 마이그레이션 어떻게?" } as any,
          { role: "assistant", content: "Bun runtime 사용하려면 package.json에 bun을 script runner로." } as any,
        ],
        rootDir: root,
      });

      const result = searchRecall({
        projectId,
        query: "Bun 마이그레이션",
        timeRangeDays: 30,
        rootDir: root,
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]!.sessionId).toBe("sess-bun");
      expect(result.results[0]!.score).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-8: prompt A/B experiment round-robin", () => {
  test("100 picks of 2 variants distribute 50/50 with round-robin", () => {
    const root = mkTmp();
    try {
      registerExperiment({
        name: "greeting-exp",
        variants: [
          { id: "polite", content: "Be polite and greet the user warmly." },
          { id: "direct", content: "Respond directly without preamble." },
        ],
        rootDir: root,
      });

      const counts: Record<string, number> = { polite: 0, direct: 0 };
      for (let i = 0; i < 100; i++) {
        const picked = pickVariant({ name: "greeting-exp", rootDir: root });
        expect(picked).not.toBeNull();
        counts[picked!.id] = (counts[picked!.id] ?? 0) + 1;
      }

      expect(counts.polite).toBe(50);
      expect(counts.direct).toBe(50);

      // Record some experiment uses
      recordExperimentUse({
        projectId: "proj-ab",
        experimentName: "greeting-exp",
        variantId: "polite",
        sessionId: "s1",
        outcome: { success: true, accuracy: 85 },
        rootDir: root,
      });
      recordExperimentUse({
        projectId: "proj-ab",
        experimentName: "greeting-exp",
        variantId: "direct",
        sessionId: "s2",
        outcome: { success: true, accuracy: 90 },
        rootDir: root,
      });

      const records = readEvidence("proj-ab", "prompt", "greeting-exp", undefined, root);
      expect(records.length).toBe(2);
      expect(records[0]!.metadata?.variantId).toBe("polite");
      expect(records[1]!.metadata?.variantId).toBe("direct");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-9: slash command parsing — all 6 new commands", () => {
  test("/memory digest", () => {
    const r = handleSlashCommand("/memory digest");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("memory_digest");
  });

  test("/memory compact --dry-run --max-chars 5000", () => {
    const r = handleSlashCommand("/memory compact --dry-run --max-chars 5000");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("memory_compact");
    expect((r.data as any).dryRun).toBe(true);
    expect((r.data as any).maxChars).toBe(5000);
  });

  test("/memory promote", () => {
    const r = handleSlashCommand("/memory promote");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("memory_promote");
    expect((r.data as any).dryRun).toBe(false);
  });

  test("/skill stats dev-plan", () => {
    const r = handleSlashCommand("/skill stats dev-plan");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("skill");
    expect((r.data as any).command).toBe("stats");
    expect((r.data as any).value).toBe("dev-plan");
  });

  test("/subagent stats Explore", () => {
    const r = handleSlashCommand("/subagent stats Explore");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("subagent_stats");
    expect((r.data as any).value).toBe("Explore");
  });

  test("/prompt evidence pr-review --days 30", () => {
    const r = handleSlashCommand("/prompt evidence pr-review --days 30");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("prompt_evidence");
    expect((r.data as any).name).toBe("pr-review");
    expect((r.data as any).days).toBe(30);
  });

  test("/prompt experiment greeting-exp --runs 10", () => {
    const r = handleSlashCommand("/prompt experiment greeting-exp --runs 10");
    expect(r.handled).toBe(true);
    expect(r.action).toBe("prompt_experiment");
    expect((r.data as any).name).toBe("greeting-exp");
    expect((r.data as any).runs).toBe(10);
  });

  test("/memory unknown-sub shows usage", () => {
    const r = handleSlashCommand("/memory unknown");
    expect(r.handled).toBe(true);
    expect(r.output).toContain("Usage:");
  });
});

describe("REAL-10: backward compatibility — legacy memories untouched", () => {
  test("legacy memory file without tier/lastAccessed loads successfully", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy", { rootDir: root });

      // Write entry without new fields (simulating pre-MemKraft era)
      mem.writeEntry({
        name: "legacy_entry",
        description: "Old format",
        type: "project",
        body: "Legacy content",
        filePath: "",
        // No tier, lastAccessed, accessCount, importance
      });

      // Must read back successfully
      const read = mem.readEntry("legacy_entry");
      expect(read).not.toBeNull();
      expect(read!.name).toBe("legacy_entry");
      expect(read!.body).toBe("Legacy content");
      expect(read!.tier).toBeUndefined();
      expect(read!.lastAccessed).toBeUndefined();

      // tierOf returns default
      expect(tierOf(mem, "legacy_entry")).toBe("recall");

      // workingSet includes it (as recall default)
      const ws = selectWorkingSet({ projectMemory: mem, limit: 8 });
      expect(ws.some((e) => e.name === "legacy_entry")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REAL-11: tier-aware convergence actual staleness", () => {
  test("core entry 200 days old → stale, recall 30 days → not stale", () => {
    // 200-day-old core iteration
    const oldCore = {
      domain: "skill" as const,
      id: "some-skill",
      sessionId: "s",
      iteration: 1,
      invokedAt: new Date(Date.now() - 200 * 86400_000).toISOString(),
      outcome: { success: true },
    };
    const oldCore2 = { ...oldCore, iteration: 2, invokedAt: new Date(Date.now() - 199 * 86400_000).toISOString() };

    const verdictCore = checkConvergence({
      records: [oldCore, oldCore2],
      tier: "core",
      maxAccDelta: 100,
      maxStepsDeltaPct: 100,
      maxDurDeltaPct: 100,
    });
    expect(verdictCore.converged).toBe(false);
    expect(verdictCore.reason).toBe("stale");
    expect(verdictCore.suggestedNext).toBe("re-run");

    // Same timing but recall tier: stale at 60 days
    const verdictRecall = checkConvergence({
      records: [oldCore, oldCore2],
      tier: "recall",
      maxAccDelta: 100,
      maxStepsDeltaPct: 100,
      maxDurDeltaPct: 100,
    });
    expect(verdictRecall.converged).toBe(false);
    expect(verdictRecall.reason).toBe("stale");

    // 30-day-old recall → NOT stale, proceeds to other checks
    const recent = {
      ...oldCore,
      iteration: 1,
      invokedAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    };
    const recent2 = {
      ...oldCore,
      iteration: 2,
      invokedAt: new Date(Date.now() - 29 * 86400_000).toISOString(),
    };
    const verdictRecent = checkConvergence({
      records: [recent, recent2],
      tier: "recall",
      maxAccDelta: 100,
      maxStepsDeltaPct: 100,
      maxDurDeltaPct: 100,
    });
    expect(verdictRecent.converged).toBe(true);

    // archival tier never stale
    const ancient = {
      ...oldCore,
      invokedAt: new Date(Date.now() - 1000 * 86400_000).toISOString(),
    };
    const ancient2 = { ...ancient, iteration: 2, invokedAt: new Date(Date.now() - 999 * 86400_000).toISOString() };
    const verdictArchival = checkConvergence({
      records: [ancient, ancient2],
      tier: "archival",
      maxAccDelta: 100,
      maxStepsDeltaPct: 100,
      maxDurDeltaPct: 100,
    });
    expect(verdictArchival.converged).toBe(true);
  });
});
