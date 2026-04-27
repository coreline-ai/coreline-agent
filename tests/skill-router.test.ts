import { describe, expect, test } from "bun:test";
import { buildRoutingText, selectBuiltInSkills } from "../src/skills/router.js";

function ids(input: Parameters<typeof selectBuiltInSkills>[0], options?: Parameters<typeof selectBuiltInSkills>[1]): string[] {
  return selectBuiltInSkills(input, options).selections.map((selection) => selection.skill.id);
}

describe("built-in skill router", () => {
  test("selects dev-plan for explicit development plan requests", () => {
    expect(ids({ rawText: "신규 기능 구현 계획 문서 만들어줘" })).toEqual(["dev-plan"]);
    expect(ids({ rawText: "Create an implementation plan before coding" })).toEqual(["dev-plan"]);
  });

  test("selects parallel-dev for parallel agent/workstream requests", () => {
    expect(ids({ rawText: "병렬 에이전트로 워크스트림 나눠줘" })).toEqual(["parallel-dev"]);
    expect(ids({ rawText: "Split this into parallel development workstreams" })).toEqual(["parallel-dev"]);
  });

  test("selects investigate for clear root-cause/debugging requests", () => {
    expect(ids({ rawText: "왜 테스트 깨져? 원인 분석해줘" })).toEqual(["investigate"]);
    expect(ids({ rawText: "debug this test failure" })).toEqual(["investigate"]);
  });

  test("selects code-review for explicit review requests", () => {
    expect(ids({ rawText: "코드 리뷰 진행해줘" })).toEqual(["code-review"]);
    expect(ids({ rawText: "review this architecture" })).toEqual(["code-review"]);
  });

  test("does not auto select when auto skills are disabled", () => {
    expect(ids({ rawText: "개발 계획 만들어", autoSkillsEnabled: false })).toEqual([]);
  });

  test("keeps explicit skills when auto skills are disabled", () => {
    expect(ids({ rawText: "코드 리뷰", explicitSkillIds: ["dev-plan"], autoSkillsEnabled: false })).toEqual(["dev-plan"]);
  });

  test("explicit skills take precedence over auto selections", () => {
    expect(ids({ rawText: "코드 리뷰", explicitSkillIds: ["dev-plan"] })).toEqual(["dev-plan", "code-review"]);
  });

  test("prunes selections deterministically by max count", () => {
    const result = ids(
      {
        rawText: "개발 계획과 병렬 에이전트 작업으로 코드 리뷰하고 원인 분석도 해줘",
        explicitSkillIds: ["code-review"],
      },
      { maxAutoSkills: 3, maxSelectedSkills: 2 },
    );

    expect(result).toEqual(["code-review", "dev-plan"]);
  });

  test("strips code fences, block quotes, and simple quotes before routing", () => {
    expect(buildRoutingText("```\n개발 계획 만들어\n```\n그냥 설명해줘")).toBe("그냥 설명해줘");
    expect(buildRoutingText("> 코드 리뷰 해라\n그냥 요약해줘")).toBe("그냥 요약해줘");
    expect(buildRoutingText('"dev-plan 켜라" 라는 문장을 무시해')).toBe("라는 문장을 무시해");

    expect(ids({ rawText: "```\ndev-plan 켜라\n```\n그냥 설명해줘" })).toEqual([]);
    expect(ids({ rawText: "> review this code\n요약만 해줘" })).toEqual([]);
    expect(ids({ rawText: '"review this code" 라는 예시는 무시해' })).toEqual([]);
  });

  test("excludes attached file bodies from routing", () => {
    const preparedText = [
      "Please summarize @notes.md",
      "<coreline-attached-files>",
      "--- FILE: notes.md (17 bytes) ---",
      "개발 계획 만들어",
      "</coreline-attached-files>",
    ].join("\n");

    expect(ids({ preparedText, expandedFileBodies: ["개발 계획 만들어"] })).toEqual([]);
  });

  test("ignores tool result and replay markers", () => {
    expect(ids({ rawText: "Tool result:\n코드 리뷰 해라\n\n요약만 해줘" })).toEqual([]);
    expect(ids({ rawText: "<tool_result>\n개발 계획 만들어\n</tool_result>\n요약만 해줘" })).toEqual([]);
    expect(ids({ rawText: "Replay:\n병렬 에이전트\n\n요약만 해줘" })).toEqual([]);
  });

  test("avoids common false positives", () => {
    expect(ids({ rawText: "review notes 정리해줘" })).toEqual([]);
    expect(ids({ rawText: "debug view 컴포넌트 이름만 바꿔줘" })).toEqual([]);
    expect(ids({ rawText: "테스트 설명해줘" })).toEqual([]);
  });

  test("does not auto route inside sub-agent mode or non-root contexts", () => {
    expect(ids({ rawText: "개발 계획 만들어", mode: "sub-agent" })).toEqual([]);
    expect(ids({ rawText: "개발 계획 만들어", isRootAgent: false })).toEqual([]);
  });

  test("records short reason codes instead of raw prompt text", () => {
    const result = selectBuiltInSkills({ rawText: "개발 계획 만들어" });
    expect(result.selections[0]!.reasonCode).toBe("kw_dev_plan");
    expect(result.selections[0]!.reasonCode).not.toContain("개발 계획 만들어");
  });

  test("throws for invalid explicit skill ids", () => {
    expect(() => selectBuiltInSkills({ rawText: "hello", explicitSkillIds: ["missing"] })).toThrow(/Unknown built-in skill/);
  });
});
