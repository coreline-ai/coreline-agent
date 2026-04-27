/**
 * Tests for applied-skill-registry — LRU cache for active skill selections.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumeAppliedSkills,
  registerSkillSelection,
  registrySize,
  resetRegistry,
} from "../src/agent/self-improve/applied-skill-registry.js";
import type { SkillSelection } from "../src/skills/types.js";

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

describe("applied-skill-registry", () => {
  beforeEach(() => {
    resetRegistry();
  });

  test("register + consume roundtrip", () => {
    registerSkillSelection("sess-1", [makeSelection("dev-plan")]);
    expect(registrySize()).toBe(1);
    const result = consumeAppliedSkills("sess-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.skill.id).toBe("dev-plan");
    expect(registrySize()).toBe(0);
  });

  test("consume returns [] for unknown sessionId", () => {
    expect(consumeAppliedSkills("nope")).toEqual([]);
  });

  test("LRU eviction after 100 sessions", () => {
    for (let i = 0; i < 110; i += 1) {
      registerSkillSelection(`sess-${i}`, [makeSelection("dev-plan")]);
    }
    expect(registrySize()).toBe(100);
    // Oldest ones (sess-0..sess-9) should have been evicted.
    expect(consumeAppliedSkills("sess-0")).toEqual([]);
    expect(consumeAppliedSkills("sess-9")).toEqual([]);
    // Most recent must still be present.
    expect(consumeAppliedSkills("sess-109")).toHaveLength(1);
  });

  test("duplicate register on same sessionId merges by skill.id (I1 fix)", () => {
    // Post I1 fix: cross-turn accumulation.
    // Turn 1 selects dev-plan; turn 2 selects code-review + investigate.
    // Session-end consume should see all three.
    registerSkillSelection("sess-dup", [makeSelection("dev-plan")]);
    registerSkillSelection("sess-dup", [makeSelection("code-review"), makeSelection("investigate")]);
    const result = consumeAppliedSkills("sess-dup");
    expect(result).toHaveLength(3);
    const ids = result.map((s) => s.skill.id).sort();
    expect(ids).toEqual(["code-review", "dev-plan", "investigate"]);
  });

  test("re-register same skill.id on same sessionId is deduplicated", () => {
    registerSkillSelection("sess-re", [makeSelection("dev-plan")]);
    registerSkillSelection("sess-re", [makeSelection("dev-plan")]);
    const result = consumeAppliedSkills("sess-re");
    expect(result).toHaveLength(1);
    expect(result[0]!.skill.id).toBe("dev-plan");
  });
});
