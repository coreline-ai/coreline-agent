import type { BuiltInSkill } from "./types.js";

const COMMON_MODES = ["chat", "one-shot", "plan", "goal", "autopilot"] as const;

export const BUILT_IN_SKILL_CATALOG = [
  {
    id: "dev-plan",
    title: "Development Plan",
    summary: "Create a scoped, phased implementation plan before coding.",
    priority: 100,
    autoEnabled: true,
    modeConstraints: COMMON_MODES,
    triggers: [
      {
        reasonCode: "kw_dev_plan",
        patterns: [
          /(?:개발|구현|실행)\s*(?:계획|플랜|문서)/i,
          /(?:계획|플랜)\s*(?:문서|작성|만들|짜)/i,
          /\bdev[-\s]?plan\b/i,
          /\bimplement(?:ation)?\s+plan\b/i,
          /\bphase\s*\d+\b/i,
        ],
      },
    ],
    content: [
      "Clarify the goal, non-goals, and affected project docs first.",
      "Create or update a dev-plan/implement_*.md file before coding.",
      "Break work into phases with concrete files, tests, and done criteria.",
      "Prefer small, reversible steps and call out shared integration points.",
      "Do not expand scope without explicit user confirmation.",
    ].join("\n"),
  },
  {
    id: "parallel-dev",
    title: "Parallel Development",
    summary: "Split implementation into safe workstreams with ownership boundaries.",
    priority: 95,
    autoEnabled: true,
    modeConstraints: COMMON_MODES,
    triggers: [
      {
        reasonCode: "kw_parallel_dev",
        patterns: [
          /병렬\s*(?:에이전트|개발|구현|작업|워크스트림)/i,
          /(?:여러|복수)\s*에이전트/i,
          /파일\s*소유권|소유\s*경로/i,
          /\bparallel\s+(?:dev|development|agent|agents|work)/i,
          /\bworkstreams?\b/i,
        ],
      },
    ],
    content: [
      "Map owned paths, shared files, and integration-only files before edits.",
      "Assign each worker a narrow goal, allowed paths, forbidden paths, and tests.",
      "Keep shared contracts stable; land foundation work before dependent work.",
      "Never revert another worker's changes; report conflicts to the integrator.",
      "Merge deterministically: foundation, leaf workstreams, integration, full tests.",
    ].join("\n"),
  },
  {
    id: "investigate",
    title: "Root Cause Investigation",
    summary: "Find the cause before fixing bugs, failures, or broken behavior.",
    priority: 90,
    autoEnabled: true,
    modeConstraints: COMMON_MODES,
    triggers: [
      {
        reasonCode: "kw_investigate",
        patterns: [
          /원인\s*분석/i,
          /왜\s+.*(?:깨|실패|안\s*돼|오류|에러|버그)/i,
          /테스트.*(?:깨|실패|fail)/i,
          /(?:오류|에러|버그|실패).*(?:원인|분석|확인|수정)/i,
          /\broot\s+cause\b/i,
          /\bdebug(?:ging)?\s+(?:this|issue|error|failure|bug)\b/i,
          /\bfix\s+(?:bug|error|failure|test)\b/i,
        ],
      },
    ],
    content: [
      "Reproduce the symptom and capture the exact failing signal first.",
      "Inspect recent changes, data flow, and boundaries before editing code.",
      "State the likely root cause and the evidence that supports it.",
      "Apply the smallest targeted fix; avoid speculative rewrites.",
      "Verify with the narrow failing test, then the relevant regression suite.",
    ].join("\n"),
  },
  {
    id: "code-review",
    title: "Code Review",
    summary: "Review architecture, correctness, tests, safety, and regressions.",
    priority: 80,
    autoEnabled: true,
    modeConstraints: COMMON_MODES,
    triggers: [
      {
        reasonCode: "kw_code_review",
        patterns: [
          /코드\s*리뷰/i,
          /전문가\s*리뷰/i,
          /(?:구조|설계|아키텍처)\s*검토/i,
          /\bcode\s+review\b/i,
          /\breview\s+(?:this|code|diff|pr|architecture|design)\b/i,
          /\barchitecture\s+review\b/i,
        ],
      },
    ],
    content: [
      "Check intent fit, architecture boundaries, and source-of-truth drift.",
      "Look for correctness, safety, permission, privacy, and regression risks.",
      "Verify tests cover behavior, edge cases, and failure modes.",
      "Separate must-fix issues from follow-up suggestions.",
      "Report concrete file/function-level recommendations when possible.",
    ].join("\n"),
  },
] as const satisfies readonly BuiltInSkill[];

export const BUILT_IN_SKILL_IDS = BUILT_IN_SKILL_CATALOG.map((skill) => skill.id);
