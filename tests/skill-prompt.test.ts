import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, formatActiveSkillsSection } from "../src/agent/system-prompt.js";
import { selectBuiltInSkills } from "../src/skills/router.js";

const cwd = process.cwd();

describe("built-in skill prompt integration", () => {
  test("keeps prompt unchanged when no active skills are supplied", () => {
    const base = buildSystemPrompt(cwd, []);
    const withEmptyOptions = buildSystemPrompt(cwd, [], undefined, undefined, undefined, { activeSkills: [] });
    expect(withEmptyOptions).toBe(base);
  });

  test("formats active skills as advisory system prompt section", () => {
    const result = selectBuiltInSkills({ rawText: "개발 계획 문서 만들어줘", mode: "chat", isRootAgent: true });
    const section = formatActiveSkillsSection(result.selections);
    expect(section).toContain("# Active Built-in Skills");
    expect(section).toContain("advisory workflow procedures");
    expect(section).toContain("dev-plan: Development Plan");
    expect(section).not.toContain("개발 계획 문서 만들어줘");
  });

  test("injects active skills without raw routing text", () => {
    const result = selectBuiltInSkills({ rawText: "코드 리뷰 해줘", mode: "chat", isRootAgent: true });
    const prompt = buildSystemPrompt(cwd, [], undefined, undefined, undefined, { activeSkills: result.selections });
    expect(prompt).toContain("# Active Built-in Skills");
    expect(prompt).toContain("code-review: Code Review");
    expect(prompt).not.toContain("코드 리뷰 해줘");
  });
});
