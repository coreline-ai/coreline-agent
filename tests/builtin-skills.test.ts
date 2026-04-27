import { describe, expect, test } from "bun:test";
import { BUILT_IN_SKILL_CATALOG, BUILT_IN_SKILL_IDS } from "../src/skills/catalog.js";
import { formatSkillForDisplay, formatSkillForPrompt, getBuiltInSkill, listBuiltInSkills, validateBuiltInSkillCatalog } from "../src/skills/registry.js";
import { BUILT_IN_SKILL_POLICY, type SkillSelection } from "../src/skills/types.js";

describe("built-in skill catalog", () => {
  test("exposes the v1 built-in skills", () => {
    expect(BUILT_IN_SKILL_IDS).toEqual(["dev-plan", "parallel-dev", "investigate", "code-review"]);
    expect(listBuiltInSkills().map((skill) => skill.id)).toEqual(BUILT_IN_SKILL_IDS);
  });

  test("keeps catalog definitions valid and unique", () => {
    expect(() => validateBuiltInSkillCatalog()).not.toThrow();
    expect(new Set(BUILT_IN_SKILL_IDS).size).toBe(BUILT_IN_SKILL_IDS.length);
  });

  test("keeps skill content compact and colocates triggers with metadata", () => {
    for (const skill of BUILT_IN_SKILL_CATALOG) {
      expect(skill.content.length).toBeLessThanOrEqual(BUILT_IN_SKILL_POLICY.maxTotalPromptChars);
      expect(skill.content.split("\n").length).toBeGreaterThanOrEqual(5);
      expect(skill.content.split("\n").length).toBeLessThanOrEqual(8);
      expect(skill.triggers.length).toBeGreaterThan(0);
      expect(skill.modeConstraints).not.toContain("sub-agent");
    }
  });

  test("returns undefined for unknown skills", () => {
    expect(getBuiltInSkill("missing-skill")).toBeUndefined();
  });

  test("formats skills without raw prompt text or raw reason text", () => {
    const skill = getBuiltInSkill("dev-plan")!;
    const selection: SkillSelection = {
      skill,
      source: "auto",
      reasonCode: "kw_dev_plan",
      priority: skill.priority,
    };

    const prompt = formatSkillForPrompt(selection);
    const display = formatSkillForDisplay("dev-plan");

    expect(prompt).toContain("dev-plan");
    expect(prompt).toContain("kw_dev_plan");
    expect(prompt).not.toContain("개발 계획 만들어");
    expect(display).toContain("Development Plan");
    expect(display).not.toContain("개발 계획 만들어");
  });
});
