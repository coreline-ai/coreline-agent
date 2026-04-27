# Implementation Status

> Last synced: 2026-04-26
> Project: coreline-agent

이 문서는 오래된 구현 계획 문서와 현재 코드/테스트 상태를 구분하기 위한 동기화 기준 문서다.

## Current source of truth

| 영역 | 현재 기준 |
|------|-----------|
| 사용자 기능/사용법 | `README.md` |
| 에이전트 개발 규칙 | `AGENTS.md` |
| 완료/진행 이력 | `dev-plan/implement_*.md` |
| 실제 구현 여부 | `src/**` + `tests/**` |
| smoke 기준 | `docs/smoke.md`, `docs/provider-smoke-*.md` |

## Current verification baseline

최근 전체 검증 기준:

```txt
bun run typecheck pass
bun run build pass
bun test 1504 pass / 0 fail / 205 files / 5442 expects
```

최근 병렬 구현 통합 중 재확인한 관련 테스트:

```txt
53 pass / 0 fail / 220 expects
1504 pass / 0 fail / 205 files / 5442 expects
```

대상:

```txt
tests/hooks-engine.test.ts
tests/hooks-permission.test.ts
tests/hooks-command.test.ts
tests/phase2-tools.test.ts
tests/fix-tools-edge.test.ts
tests/file-tools-safety.test.ts
tests/phase3-permissions.test.ts
tests/fix-security.test.ts
tests/filesystem-hardening.test.ts
tests/cloud-oauth-providers.test.ts
tests/provider-override.test.ts
tests/provider-smoke.test.ts
tests/codex-auth.test.ts
tests/bash-security.test.ts
tests/cost-tracker.test.ts
tests/tui-polish.test.ts
tests/status-stream.test.ts
tests/memory-safety.test.ts
tests/mcp-resources.test.ts
tests/todo-write.test.ts
tests/ask-user-question.test.ts
```

## Completed current dev-plans

| 문서 | 상태 | 기준 |
|------|------|------|
| `dev-plan/implement_20260419_170411.md` | 완료 | Hardening Track 2~3 최소 계약, GitTool, ToolCache, FileTransaction |
| `dev-plan/implement_20260419_170412.md` | 완료 | Context collector, prompt macro parse/adapter, benchmark runner |
| `dev-plan/implement_20260419_170413.md` | 완료 | A2A adapter boundary, dashboard shell, status SSE, clideck adapter |
| `dev-plan/implement_20260419_171641.md` | 완료 | Built-in skill catalog/router/prompt/CLI/TUI wiring |
| `dev-plan/implement_20260419_223101.md` | 완료 | Parallel Agent Runtime v1 task registry/scheduler/background child/TUI commands |
| `dev-plan/implement_20260420_201455.md` | 완료 | Scaffold, runtime tweaks, context snip, fork verifier operator UX |
| `dev-plan/implement_20260420_210349.md` | 완료 | Parallel Agent Runtime v1.5 hardening: worktree helper, owned path workstream cards, auto verifier, parallel task export |
| `dev-plan/implement_20260424_203434.md` | 완료 | coreline-cli 적용 가능 모듈 1~6: PostTool, FileRead/FileEdit safety, filesystem hardening, Codex auth/config, Bash parser/security |
| `dev-plan/implement_20260424_210444.md` | 완료 | V2: Bash parser/security, FS/File symlink+atomic hardening, command-hook safe runner, Codex/cost/statusline observability |
| `dev-plan/implement_20260424_224740.md` | 완료 | V2.1: secret scanner, result storage, MCP resources, FileRead/FileEdit read-state, TodoWrite, AskUserQuestion |

## Implemented capability map

| Capability | Implemented baseline | Representative tests/docs |
|------------|----------------------|---------------------------|
| Core loop/tools/permissions | Agent loop, 12 core tools, MCP bridge/resource tools, permission engine, PreTool/PostTool hook integration, internal command-hook safe runner, Bash V2 quote/wrapper/heredoc/nested-exec classifier, file permission hardening, large tool-result storage | `tests/phase*.test.ts`, `tests/hooks-*.test.ts`, `tests/hooks-command.test.ts`, `tests/bash-security.test.ts`, `tests/filesystem-hardening.test.ts`, `tests/git-tool.test.ts`, `tests/mcp-resources.test.ts`, `tests/todo-write.test.ts`, `tests/ask-user-question.test.ts` |
| Provider layer | Anthropic, OpenAI, Gemini, OpenAI-compatible, OAuth, CLI-backed providers, Codex auth/config/quota metadata reader | `tests/phase1-providers.test.ts`, `tests/provider-*.test.ts`, `tests/codex-auth.test.ts` |
| Proxy layer | `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v2/status`, `/v2/batch`, `/v2/capabilities`, SSE status, dashboard shell | `tests/proxy-*.test.ts`, `docs/proxy-operations.md` |
| Agent delegation | AgentTool, depth-2 recursion, coordinator, pipeline, Parallel Agent Runtime v1/v1.5 background tasks, owned/non-owned workstream cards, worktree helper candidate, remote scheduler | `tests/agent-tool*.test.ts`, `tests/subagent*.test.ts`, `tests/pipeline-*.test.ts`, `tests/parallel-agent-*.test.ts` |
| Planning/reliability | plan-execute, replanner, goal/autopilot, completion judge, trace, recovery, verification pack, FileRead/FileEdit V2 safety utilities including read-before-write, stale-write guard, binary guard, and atomic edit write | `tests/plan-execute-*.test.ts`, `tests/reliability-*.test.ts`, `tests/file-tools-safety.test.ts`, `docs/single-agent-reliability.md` |
| Operator UX | session export with parallel task evidence, watchdog, status bar/runtime tweaks, prompt library, transcript search/replay, built-in skills, scaffold, manual `/verify`, opt-in auto verifier, provider/model/reasoning/cost/quota statusline metadata | `tests/session-export.test.ts`, `tests/watchdog.test.ts`, `tests/skill-*.test.ts`, `tests/scaffold.test.ts`, `tests/runtime-tweaks.test.ts`, `tests/fork-verifier.test.ts`, `tests/auto-verifier.test.ts`, `tests/operator-ux-commands.test.ts`, `tests/tui-polish.test.ts`, `tests/status-stream.test.ts` |
| Memory/MCP | project memory, AGENT.md loading, auto summary, high-confidence secret scanner, MCP stdio bridge, MCP resources list/read | `tests/memory-*.test.ts`, `tests/memory-safety.test.ts`, `tests/mcp-*.test.ts`, `tests/mcp-resources.test.ts`, `docs/memory-system.md`, `docs/mcp-ops.md` |


## Archived implementation plans

아래 문서는 현재 active TODO 목록이 아니라 과거 설계 기록이다. 미완료 체크박스가 현재 미구현을 뜻하지 않도록 문서 상단에 archive/superseded 배너를 추가했고, 과거 체크박스는 `(historical task)`로 변환했다.

| 문서 | 현재 판정 | 대체 기준 |
|------|-----------|-----------|
| `docs/impl-plan-coding-agent.md` | Archived / superseded | `README.md`, `AGENTS.md`, 최신 `dev-plan/*.md` |
| `docs/impl-plan-intelligence-accumulation.md` | Archived / superseded | `docs/memory-system.md`, `tests/memory-*.test.ts` |
| `docs/impl-plan-bugfix-hardening.md` | Archived / superseded | `tests/fix-*.test.ts`, provider/security/TUI tests |

## Deliberate follow-up items

아래 항목은 “빠진 구현”이 아니라 최신 개발 문서에서 의도적으로 후속으로 분리한 항목이다.

| 우선순위 | 항목 | 현재 상태 |
|----------|------|-----------|
| P1 | Hardening Track 3 실제 구현 | `src/agent/hardening-track3.ts`에 계약만 있음 |
| P1 | Prompt Macro 저장/실행/기록 | v1은 parse/validate/pipeline adapter만 구현 |
| P1 | A2A 실제 task execution | 현재는 adapter boundary + disabled default |
| P2 | Hook Engine public command hook config/registration | internal opt-in safe runner는 구현됨. 공개 `hooks.yml` persistence와 interactive approval adapter는 후속 |
| P2 | TUI/autopilot/provider smoke 확장 | `docs/smoke.md` 후속 범위 |
| P2 | Built-in Skill v1.1 | `test-fix`, `release-docs`, `safety`, eval suite |
| P3 | 외부 설치형 스킬 시스템 | built-in skill 안정화 후 별도 계획 |
| P3 | Parallel Agent worktree 자동 merge/PR | v1.5는 helper만 제공, merge/push/rebase 자동화 제외 |
| P3 | `/agent resume` 실제 재개 | v1/v1.5는 조회/중단/미지원 안내까지 구현 |

## 메모리 레퍼런스 Integration (v2.x)

| Phase | 제목 | 상태 | 대표 테스트 |
|-------|------|------|-------------|
| 0 | 기반: paths/types/constants/project-id/metadata 확장 | done | `tests/memory-frontmatter-extended.test.ts`, `tests/memory-basic.test.ts` |
| 1 | memory-parser 확장 (serialize/extract extended) | done | `tests/memory-parser.test.ts` |
| 2 | tiering 모듈 (tierSet/Touch/List/defaultTierForType) | done | `tests/memory-tiering.test.ts` |
| 3 | working-set selector | done | `tests/memory-working-set.test.ts` |
| 4 | auto-summary tier 매핑 | done | `tests/auto-summary-tiering.test.ts` |
| 5 | evidence store + summariseEval | done | `tests/self-improve-evidence.test.ts`, `tests/self-improve-eval.test.ts` |
| 6 | compaction 규칙 (age/importance/maxChars) | done | `tests/memory-compaction.test.ts` |
| 7 | digest (MEMORY.md) + writeDigest | done | `tests/memory-digest.test.ts` |
| 8 | MemoryRecall tool + session-recall index/search | done | `tests/memory-recall.test.ts` |
| 9 | skill/subagent/prompt tracker + applied-skill-registry | done | `tests/applied-skill-registry.test.ts`, `tests/skill-tracker.test.ts`, `tests/subagent-tracker.test.ts` |
| 10 | prompt evidence search + experiment registry | done | `tests/prompt-evidence-search.test.ts`, `tests/prompt-experiment.test.ts` |
| 11 | convergence (tier-aware staleness) | done | `tests/self-improve-convergence-tier.test.ts` |
| 12 | plan-execute convergence gate | done | `tests/plan-execute-convergence-gate.test.ts` |
| 13 | auto-promote + lifecycle digest factory | done | `tests/memory-auto-promote.test.ts` |
| 14 | 통합/스모크/문서 | done | `tests/memkraft-integration-smoke.test.ts` (7 pass) |

총 1018 tests passing after integration (smoke: 5 pass). Typecheck clean.

## Review rule

미구현 여부를 판단할 때는 아래 순서로 확인한다.

1. 최신 `dev-plan/implement_*.md`의 체크박스와 최종 결과 요약
2. 해당 기능의 `src/**` 구현 파일 존재 여부
3. 해당 기능의 `tests/**` 검증 여부
4. README/AGENTS의 사용자 문서 반영 여부
5. `docs/impl-plan-*.md`는 archive 문서이므로 active TODO로 계산하지 않음
