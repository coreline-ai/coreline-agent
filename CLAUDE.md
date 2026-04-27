# CLAUDE.md — coreline-agent

이 파일은 AI 코딩 에이전트(Claude Code, coreline-agent 자신 포함)가 이 프로젝트에서 작업할 때 반드시 따라야 하는 지침이다.

## 프로젝트 개요

- **이름**: coreline-agent
- **목적**: 다중 LLM 프로바이더를 하나의 터미널 TUI + 로컬 프록시로 연결하는 코딩 에이전트
- **런타임**: Bun >= 1.1.0
- **언어**: TypeScript 5.7 (strict mode)
- **UI**: Ink 5 (React 18 기반 터미널 UI)
- **현재 기준선**: 1504 tests / 205 files / 45 dev-plans

## 빌드 & 테스트 명령어

```bash
bun install # 의존성 설치
bun run typecheck # tsc --noEmit (에러 0건 유지 필수)
bun test # 전체 테스트 (현재 1504 tests / 205 files)
bun run build # dist/ 번들 생성
bun run dev # TUI 실행
bun run dev:proxy # 프록시 서버 실행
bun run smoke # smoke tests
bun run smoke:proxy # 프록시 smoke
bun run smoke:agent # 싱글 에이전트 quality smoke
```

## 코드 작성 규칙

### TypeScript
- `strict: true` 필수. `any` 사용 최소화, `as` 캐스팅보다 타입 가드 선호.
- 모든 import에 `.js` 확장자 포함 (ESM, `"module": "ES2022"`).
- 새 파일 작성 시 파일 상단에 JSDoc 한 줄 주석으로 파일 목적 설명.

### 파일 구조
- `src/` 하위 모듈별 디렉토리:
 - `agent/` — 에이전트 루프, 컨텍스트, 서브에이전트, plan-execute, remote, parallel, reliability, pipeline, status, lifecycle, 신뢰성 보강 (backup, diff, test-runner, cost-tracker, fork-verifier, context-snip, watchdog, self-correct)
 - `providers/` — LLM 프로바이더 어댑터 (9종)
 - `proxy/` — 로컬 HTTP 프록시 (Anthropic/OpenAI/Responses API, A2A, SSE, hooks, dashboard)
 - `tools/` — 내장 도구 (Bash, FileRead, FileWrite, FileEdit, Glob, Grep, MemoryRead, MemoryWrite, Agent, Git, TodoWrite, AskUserQuestion, MCP bridge/resources)
 - `tui/` — 터미널 UI (repl, status-bar, streaming-output, prompt-input, permission-prompt 등)
 - `memory/` — 프로젝트 메모리, AGENT.md 로더, auto-summary
 - `config/` — YAML 설정 로더/스키마, runtime-tweaks, diagnostics
 - `permissions/` — 도구 권한 엔진, matcher, parser
 - `session/` — 세션 히스토리, transcript, search, replay, export
 - `hooks/` — Hook Engine (function/http/disabled-by-default command hook, PreTool/PostTool, coreline events)
 - `skills/` — 내장 스킬 카탈로그/라우터 (dev-plan, parallel-dev, investigate, code-review)
 - `scaffold/` — boilerplate 생성 (/scaffold tool, provider, test)
 - `prompt/` — @file 파서, prompt library
 - `mcp/` — MCP stdio 브릿지
 - `integrations/` — 외부 도구 어댑터 (clideck)
 - `dashboard/` — 읽기 전용 status dashboard
 - `utils/` — 공유 유틸 (git, stdin, token-estimator)
- 도구는 `src/tools/{tool-name}/{tool-name}-tool.ts` 패턴.
- 테스트는 `tests/{feature}.test.ts` (src와 분리, 프로젝트 루트 tests/).

### 도구 작성 패턴
- `buildTool` 팩토리 사용 (`src/tools/types.ts`).
- `inputSchema`는 Zod 스키마로 정의.
- `checkPermissions`, `isReadOnly`, `isConcurrencySafe` 명시.
- `formatResult`로 LLM에 전달할 문자열 포맷 정의.

### 프로바이더 작성 패턴
- `LLMProvider` 인터페이스 구현 (`src/providers/types.ts`).
- `send` → `AsyncIterable<ChatChunk>` (text_delta, tool_call_start/delta/end, done).
- `ProviderType` union과 `registry.ts` factory switch에 등록.
- `config/schema.ts` Zod enum에도 추가.

### 프록시 매퍼 패턴
- 요청 변환: `toChatRequest(wireBody, signal) → ChatRequest`
- 비스트리밍 응답: `buildNonStreamingResponse(model, stream) → JSON`
- 스트리밍 응답: `to*SseEvents(model, stream) → AsyncGenerator<{event, data}>`

## 금지 사항

상세 규칙은 [AGENTS.md](AGENTS.md) 4번 "코드 수정 규칙 > 금지" 참조. 핵심만 요약:

- `node_modules/`, `dist/`, `.env` 수정 금지.
- `bun run typecheck` 에러 상태로 커밋 금지.
- `SUB_AGENT_MAX_DEPTH` > 2 금지.
- 프록시 `0.0.0.0` 인증 없이 바인딩 금지.
- 민감 정보 MemoryWrite 금지.

## 설정 파일 경로

| 파일 | 경로 | 용도 |
|------|------|------|
| `providers.yml` | `~/.coreline-agent/providers.yml` | 프로바이더 설정 |
| `config.yml` | `~/.coreline-agent/config.yml` | 런타임 설정 (theme, maxTurns, defaultProvider) |
| `permissions.yml` | `~/.coreline-agent/permissions.yml` | 도구 권한 규칙 |
| `roles.yml` | `~/.coreline-agent/roles.yml` | 역할 프리셋 |
| `mcp.yml` | `~/.coreline-agent/mcp.yml` | MCP 서버 설정 |
| `system-prompt.md` | `~/.coreline-agent/system-prompt.md` | 커스텀 시스템 프롬프트 |
| `prompts/` | `~/.coreline-agent/prompts/` | 프롬프트 라이브러리 |
| `backups/` | `~/.coreline-agent/backups/` | 파일 백업 (auto-backup + undo) |
| `status.json` | `~/.coreline-agent/status.json` | 에이전트 실행 상태 |

## 아키텍처 핵심 흐름

```
User Input → prepareUserPrompt(@file 확장) → agentLoop
 ├─ provider.send(ChatRequest) → ChatChunk stream
 ├─ tool_use → checkPermissions → PreTool hook → call → formatResult → tool_result
 ├─ Agent tool → SubAgentRuntime → child agentLoop (depth 1~2)
 │ ├─ subtasks (병렬 coordinator)
 │ ├─ pipeline (순차 handoff chain)
 │ └─ background task (ParallelAgentScheduler)
 ├─ Plan mode → Planner → Runner → Evaluator → Re-planner
 ├─ Goal mode → task state → verify → recovery → resume
 ├─ Autopilot → cycle loop → stop condition
 ├─ onLoopEnd → auto-summary → MemoryWrite (optional)
 ├─ CompletionJudge → trace → VerificationPack
 └─ Fork Verifier → background typecheck+build+test
```

## Slash commands (메모리 레퍼런스 integration)

3단계 메모리/self-improvement 로프(PHASE 14)에서 추가된 TUI 슬래시 명령:

| 명령 | 기능 |
|------|------|
| `/memory digest` | `MEMORY.md` 스냅샷을 프로젝트 메모리 디렉토리에 생성 (세션 종료 시 자동 실행) |
| `/memory compact [--dry-run] [--max-chars N]` | 오래되거나 저중요도인 메모리를 `archival`로 이동 |
| `/memory promote [--dry-run]` | `accessCount ≥ 3`인 `recall` 메모리를 `core`로 승격 |
| `/skill stats` | 스킬별 evidence 집계(pass rate, avg tool use, convergence verdict) |
| `/subagent stats` | 서브에이전트 타입별 실행 이력 요약 |
| `/prompt evidence` · `/prompt experiment` | 프롬프트 evidence 검색 및 A/B experiment 관리 (5개 design-philosophy fixture: `import { registerDesignPhilosophyExperiment } from "src/agent/self-improve/prompt-experiment-fixtures.js"`) |

### Wave 7/8/9/10/11 + 디자인 레퍼런스 추가 명령

| 명령 그룹 | 기능 |
|------|------|
| `/fact add\|at\|history\|invalidate\|list\|keys` | bitemporal 사실 기록/조회 (`memory/facts/<entity>.md`) |
| `/memory decay-apply\|decay-list\|decay-restore\|decay-run\|decay-tombstone\|decay-is-tombstoned` | decay/tombstone 라이프사이클 |
| `/link scan\|forward\|graph\|orphans` | `[[Entity]]` 위키 링크 그래프 |
| `/search-precise <query>` | 정확 substring 우선 + fuzzy fallback 검색 |
| `/search-temporal <query> [--at ISO]` · `/search-expand <query>` · `/search-v2 <query>` | bitemporal/synonym-expand/통합 검색 (Phase 11 N2) |
| `/memory health` · `/memory evidence-rotate [--dry-run]` | 메모리 무결성 점검 + evidence 보존 압축 |
| `/slop-check <path>` | AI-slop 패턴 자동 감지 (디자인 레퍼런스 Phase 3) |
| `/incident list\|show\|update\|confirm\|resolve` | 인시던트 레이어 (도구 실패 3회 자동 승격) |
| `/decision list\|show\|record\|update` | What/Why/How 결정 기록 |
| `/evidence-first <query>` | memory + incident + decision 3 도메인 동시 검색 |
| `/runbook list\|show\|match\|apply\|record` | 런북 — `apply` 는 dry-run MVP |
| `/rca <incidentId>` | hypothesis 점수 + runbook 제안 (heuristic) |
| `/memory brand-spec init\|view\|edit <name>` | 브랜드 정체성을 메모리에 저장 (logo/색상/폰트/tone) |
| `/critique <path> [--philosophy NAME] [--strategy llm\|heuristic]` | 5차원 평가 (Philosophy/Hierarchy/Craft/Functionality/Originality) |

자세한 사용법은 [docs/memkraft-integration.md](docs/memkraft-integration.md),
[docs/memkraft-wave789.md](docs/memkraft-wave789.md), [docs/huashu-integration.md](docs/huashu-integration.md).

## dev-plan 문서

개발 계획서는 `dev-plan/implement_YYYYMMDD_HHMMSS.md` 형식.
새 기능/리팩터링은 반드시 dev-plan 문서를 먼저 만들고, Phase별 체크박스로 진행한다.
기존 dev-plan 파일은 수정하되 덮어쓰지 않는다.
문서와 코드가 충돌하면 `src/**` + `tests/**` + 최신 dev-plan을 기준으로 문서를 수정한다.

## 참고 문서

- [docs/implementation-status.md](docs/implementation-status.md) — 현재 구현 기준선
- [docs/full-feature-summary.md](docs/full-feature-summary.md) — 전체 기능 요약 (17개 섹션)
- [docs/memory-system.md](docs/memory-system.md) — 메모리 시스템 설계 (3단계 tier 포함)
- [docs/memkraft-integration.md](docs/memkraft-integration.md) — 메모리 레퍼런스 통합 사용 가이드
- [docs/proxy-operations.md](docs/proxy-operations.md) — 프록시 운영 가이드
- [docs/hook-engine.md](docs/hook-engine.md) — Hook Engine 문서
- [docs/clideck-integration.md](docs/clideck-integration.md) — clideck 연동
- [docs/mcp-ops.md](docs/mcp-ops.md) — MCP 브릿지 운영
- [docs/cloud-oauth-providers.md](docs/cloud-oauth-providers.md) — OAuth 프로바이더 설정
- [docs/smoke.md](docs/smoke.md) — smoke test 표준
