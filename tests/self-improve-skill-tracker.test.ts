/**
 * Tests for skill-tracker — recordSkillRun + evaluateSessionSkills.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateSessionSkills,
  recordSkillRun,
} from "../src/agent/self-improve/skill-tracker.js";
import {
  registerSkillSelection,
  resetRegistry,
} from "../src/agent/self-improve/applied-skill-registry.js";
import { readEvidence } from "../src/agent/self-improve/evidence.js";
import { getSkillEvidenceDir } from "../src/config/paths.js";
import type { SkillSelection } from "../src/skills/types.js";

let tempRoot: string;
const PROJECT_ID = "proj-tracker-test";

function makeSelection(id: string): SkillSelection {
  return {
    skill: {
      id: id as SkillSelection["skill"]["id"],
      title: `Title ${id}`,
      summary: "s",
      content: "c",
      triggers: [],
      priority: 1,
      autoEnabled: true,
      modeConstraints: ["chat"],
    },
    source: "auto",
    reasonCode: "kw_dev_plan",
    priority: 1,
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "skill-tracker-"));
  resetRegistry();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("recordSkillRun", () => {
  test("single recordSkillRun → 1 JSONL line with schema", () => {
    const result = recordSkillRun(
      PROJECT_ID,
      {
        skillId: "dev-plan",
        sessionId: "s-1",
        outcome: { success: true, turnsUsed: 3 },
      },
      tempRoot,
    );
    expect(result.recorded).toBe(true);

    const path = join(getSkillEvidenceDir(PROJECT_ID, tempRoot), "dev-plan.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.domain).toBe("skill");
    expect(parsed.id).toBe("dev-plan");
    expect(parsed.iteration).toBe(1);
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.outcome.success).toBe(true);
    expect(parsed.outcome.turnsUsed).toBe(3);
    expect(typeof parsed.invokedAt).toBe("string");
  });

  test("5 sequential calls → 5 records, iteration counts 1-5", () => {
    for (let i = 0; i < 5; i += 1) {
      const result = recordSkillRun(
        PROJECT_ID,
        {
          skillId: "dev-plan",
          sessionId: `s-${i}`,
          outcome: { success: true },
        },
        tempRoot,
      );
      expect(result.recorded).toBe(true);
    }
    const records = readEvidence(PROJECT_ID, "skill", "dev-plan", {}, tempRoot);
    expect(records).toHaveLength(5);
    expect(records.map((r) => r.iteration)).toEqual([1, 2, 3, 4, 5]);
  });

  test("recordSkillRun with empty projectId returns {recorded:false}", () => {
    const result = recordSkillRun(
      "",
      {
        skillId: "dev-plan",
        sessionId: "s-1",
        outcome: { success: true },
      },
      tempRoot,
    );
    expect(result.recorded).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("evaluateSessionSkills", () => {
  test("no active skills → no-op (no files created)", () => {
    evaluateSessionSkills({
      projectId: PROJECT_ID,
      sessionId: "empty-session",
      turnReason: "completed",
      rootDir: tempRoot,
    });
    const dir = getSkillEvidenceDir(PROJECT_ID, tempRoot);
    expect(existsSync(dir)).toBe(false);
  });

  test("registered skills → writes one record per skill", () => {
    registerSkillSelection("sess-x", [
      makeSelection("dev-plan"),
      makeSelection("code-review"),
    ]);
    evaluateSessionSkills({
      projectId: PROJECT_ID,
      sessionId: "sess-x",
      turnReason: "completed",
      turnsUsed: 7,
      toolCalls: 12,
      durationMs: 4_321,
      rootDir: tempRoot,
    });
    const devRecords = readEvidence(PROJECT_ID, "skill", "dev-plan", {}, tempRoot);
    const reviewRecords = readEvidence(PROJECT_ID, "skill", "code-review", {}, tempRoot);
    expect(devRecords).toHaveLength(1);
    expect(reviewRecords).toHaveLength(1);
    expect(devRecords[0]!.outcome.success).toBe(true);
    expect(devRecords[0]!.outcome.turnsUsed).toBe(7);
    expect(devRecords[0]!.outcome.toolCalls).toBe(12);
    expect(devRecords[0]!.metadata?.turnReason).toBe("completed");
  });

  test("turnReason=error sets success=false", () => {
    registerSkillSelection("sess-err", [makeSelection("dev-plan")]);
    evaluateSessionSkills({
      projectId: PROJECT_ID,
      sessionId: "sess-err",
      turnReason: "error",
      rootDir: tempRoot,
    });
    const records = readEvidence(PROJECT_ID, "skill", "dev-plan", {}, tempRoot);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome.success).toBe(false);
    expect(records[0]!.metadata?.turnReason).toBe("error");
  });

  test("missing projectId swallows silently", () => {
    registerSkillSelection("sess-nope", [makeSelection("dev-plan")]);
    expect(() =>
      evaluateSessionSkills({
        projectId: "",
        sessionId: "sess-nope",
        turnReason: "completed",
        rootDir: tempRoot,
      }),
    ).not.toThrow();
  });
});
