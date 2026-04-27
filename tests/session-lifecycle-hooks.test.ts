/**
 * I1 fix verification — session-level hooks fire once per session, not once per turn.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  trackSessionTurn,
  finalizeSession,
  finalizeAllSessions,
  trackedSessionCount,
  resetSessionTracker,
} from "../src/agent/self-improve/session-lifecycle-hooks.js";
import {
  registerSkillSelection,
  consumeAppliedSkills,
  resetRegistry,
} from "../src/agent/self-improve/applied-skill-registry.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { readEvidence } from "../src/agent/self-improve/evidence.js";
import type { SkillSelection } from "../src/skills/types.js";
import type { ChatMessage } from "../src/agent/types.js";

function mkSkill(id: string): SkillSelection {
  return {
    skill: {
      id,
      title: id,
      summary: "",
      content: "",
      triggers: [],
      priority: 1,
      autoEnabled: true,
      modeConstraints: [],
    },
    source: "auto",
    reasonCode: "explicit",
    priority: 1,
  };
}

function mkMessage(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: text } as any;
}

describe("I1 fix: session-lifecycle-hooks", () => {
  beforeEach(() => {
    resetRegistry();
    resetSessionTracker();
  });

  test("trackSessionTurn accumulates without flushing", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
    try {
      const mem = new ProjectMemory("/tmp/i1-test", { rootDir: root });

      trackSessionTurn({
        sessionId: "sess-1",
        projectMemory: mem,
        messages: [mkMessage("user", "hello")],
        rootDir: root,
      });

      // No evidence written yet — accumulation only.
      const records = readEvidence(mem.projectId, "skill", "dev-plan", undefined, root);
      expect(records.length).toBe(0);
      expect(trackedSessionCount()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finalizeSession flushes evidence for 3 turns of same session → ONE skill record", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
    try {
      const mem = new ProjectMemory("/tmp/i1-once", { rootDir: root });
      const sessionId = "sess-once";

      // Router selects dev-plan on turn 1
      registerSkillSelection(sessionId, [mkSkill("dev-plan")]);
      trackSessionTurn({
        sessionId,
        projectMemory: mem,
        messages: [mkMessage("user", "turn 1")],
        rootDir: root,
      });

      // Router selects dev-plan AGAIN on turn 2 (same skill continues)
      registerSkillSelection(sessionId, [mkSkill("dev-plan")]);
      trackSessionTurn({
        sessionId,
        projectMemory: mem,
        messages: [mkMessage("user", "turn 1"), mkMessage("user", "turn 2")],
        rootDir: root,
      });

      // Router selects code-review on turn 3 (NEW skill this session)
      registerSkillSelection(sessionId, [mkSkill("code-review")]);
      trackSessionTurn({
        sessionId,
        projectMemory: mem,
        messages: [mkMessage("user", "turn 1"), mkMessage("user", "turn 2"), mkMessage("user", "turn 3")],
        rootDir: root,
      });

      // Session NOT ended yet — no evidence
      const pre = readEvidence(mem.projectId, "skill", "dev-plan", undefined, root);
      expect(pre.length).toBe(0);

      // Finalize session → flush everything
      finalizeSession(sessionId);

      const devPlanRecords = readEvidence(mem.projectId, "skill", "dev-plan", undefined, root);
      const codeReviewRecords = readEvidence(mem.projectId, "skill", "code-review", undefined, root);

      // Each skill recorded EXACTLY ONCE per session (accumulation)
      expect(devPlanRecords.length).toBe(1);
      expect(codeReviewRecords.length).toBe(1);

      // Both records share same sessionId
      expect(devPlanRecords[0]!.sessionId).toBe(sessionId);
      expect(codeReviewRecords[0]!.sessionId).toBe(sessionId);

      // Tracker cleaned up after finalize
      expect(trackedSessionCount()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finalizeAllSessions flushes multiple concurrent sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
    try {
      const memA = new ProjectMemory("/tmp/i1-multi-a", { rootDir: root });

      registerSkillSelection("sess-a", [mkSkill("dev-plan")]);
      trackSessionTurn({
        sessionId: "sess-a",
        projectMemory: memA,
        messages: [mkMessage("user", "a")],
        rootDir: root,
      });

      registerSkillSelection("sess-b", [mkSkill("investigate")]);
      trackSessionTurn({
        sessionId: "sess-b",
        projectMemory: memA,
        messages: [mkMessage("user", "b")],
        rootDir: root,
      });

      expect(trackedSessionCount()).toBe(2);

      finalizeAllSessions();
      expect(trackedSessionCount()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no session tracked without projectMemory or sessionId (no-op)", () => {
    trackSessionTurn({ sessionId: undefined, projectMemory: undefined, messages: [] });
    trackSessionTurn({ sessionId: "s", projectMemory: undefined, messages: [] });
    expect(trackedSessionCount()).toBe(0);
  });

  test("finalizeSession on unknown sessionId is a safe no-op", () => {
    expect(() => finalizeSession("nonexistent")).not.toThrow();
  });
});
