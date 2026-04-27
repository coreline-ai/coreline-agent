# AGENTS.md — coreline-agent

이 파일은 coreline-agent 자체의 `buildSystemPrompt()`가 AGENT.md/CLAUDE.md 탐색 시 로드하는 프로젝트 지침이다.
AI 에이전트(coreline-agent 포함)가 이 프로젝트의 코드를 수정할 때 준수해야 하는 규칙을 정의한다.

---

## 1. 프로젝트 식별

| 항목 | 값 |
|------|-----|
| 프로젝트명 | coreline-agent |
| 런타임 | Bun >= 1.1.0 |
| 언어 | TypeScript 5.7 (strict) |
| UI 프레임워크 | Ink 5 / React 18 |
| 모듈 시스템 | ESM (`"module": "ES2022"`) |
| 설정 디렉토리 | `~/.coreline-agent/` |
| 테스트 프레임워크 | `bun:test` |
| 현재 테스트 수 | 879 tests / 135 files |

## 2. 검증 명령어

코드 수정 후 반드시 아래를 실행하고 에러가 없어야 한다:

```bash
bun run typecheck   # TypeScript strict 컴파일 에러 0건
bun test            # 전체 테스트 통과
```

빌드 확인이 필요한 경우:

```bash
bun run build       # dist/ 생성 성공
```

신규 single-agent hardening 변경 시 함께 확인할 항목:

```bash
bun test tests/file-backup.test.ts tests/diff-preview.test.ts tests/test-runner.test.ts tests/cost-tracker.test.ts
```

## 3. 디렉토리 소유권

각 디렉토리는 명확한 책임이 있다. 수정 시 해당 영역의 계약을 반드시 확인한다.

| 디렉토리 | 책임 | 핵심 계약 |
|----------|------|----------|
| `src/agent/` | 에이전트 루프, 컨텍스트, 서브에이전트 | `AgentEvent` yield, `ChatChunk` 소비, depth 정책 |
| `src/agent/plan-execute/` | Plan-Execute-Evaluate 엔진 | `Task` 상태 전이, `Replanner` 계약 |
| `src/agent/remote/` | 원격 에이전트 디스패치 | `RemoteTaskRequest/Result`, abort 전파 |
| `src/providers/` | LLM 프로바이더 어댑터 (9종) | `LLMProvider.send()` → `AsyncIterable<ChatChunk>` |
| `src/proxy/` | 로컬 HTTP 프록시 서버 | Anthropic/OpenAI/Responses API, A2A, SSE status |
| `src/dashboard/` | 읽기 전용 status dashboard | write action/form 금지 |
| `src/integrations/` | 외부 도구 계약 어댑터 | clideck 등 adapter-only 변환 |
| `src/tools/` | 내장 도구 (12 core + MCP resource/bridge) | `Tool` 인터페이스, `buildTool()` 팩토리 |
| `src/tui/` | 터미널 UI (Ink/React) | TSX 컴포넌트, 상태바, 스트리밍 출력 |
| `src/memory/` | 프로젝트 메모리, AGENT.md 로더 | `ProjectMemoryCore`, auto-summary |
| `src/config/` | YAML 설정 로더/스키마 | Zod 검증, 원자적 쓰기 |
| `src/permissions/` | 도구 권한 엔진 | allow / deny / ask 정책 |
| `src/session/` | 세션 히스토리 | JSONL 저장, resume 복원 |
| `src/prompt/` | @file 파서, prompt macro | 토큰 파싱, 파일 확장, macro adapter |
| `src/skills/` | 내장 스킬 카탈로그/라우터 | advisory only, root-only auto selection |
| `src/mcp/` | MCP stdio 브릿지 | 서버 로드, 정책 게이팅 |
| `src/utils/` | 공유 유틸 | git, stdin, 기타 |
| `tests/` | 테스트 파일 | `{feature}.test.ts` 패턴 |

## 4. 코드 수정 규칙

### 필수 준수

- **import 경로에 `.js` 확장자** 포함 (ESM 규칙).
- **새 프로바이더** 추가 시: `ProviderType` union + `schema.ts` Zod enum + `registry.ts` factory switch 3곳 모두 수정.
- **새 도구** 추가 시: `src/tools/{name}/{name}-tool.ts` + `src/index.ts` BASE_TOOLS 배열 등록 + 테스트 추가.
- **공유 타입 변경** (`src/agent/types.ts`, `src/tools/types.ts`, `src/providers/types.ts`): 기존 소비자 전부 typecheck 통과 확인.
- **프록시 엔드포인트 추가** 시: `server.ts` 핸들러 + `v2.ts` capabilities 갱신.

### 금지

- `SUB_AGENT_MAX_DEPTH` > 2 (depth 3 이상 금지).
- depth 2 child에 write 도구 또는 Agent 도구 허용.
- `bun run typecheck` 에러 상태로 방치.
- 기존 테스트를 `.skip()` 처리하거나 삭제.
- `dist/`, `node_modules/`, `.env` 수정.
- 프록시를 `0.0.0.0`에 인증 없이 바인딩.

### 권장

- 수정 전 관련 테스트 파일을 먼저 확인.
- 큰 변경은 `dev-plan/implement_YYYYMMDD_HHMMSS.md`를 먼저 작성.
- 도구의 `checkPermissions()`는 기본 `allow`, 위험한 도구만 `ask`.
- 에러 처리는 `try-catch` 후 구조적 에러 반환 (`isError: true`), 예외 throw 최소화.

## 5. 서브에이전트 안전 규칙

AgentTool로 child agent를 위임할 때 반드시 준수:

| 규칙 | 설명 |
|------|------|
| depth 상한 | 최대 2 (root → child → grandchild) |
| depth 1 child | read + write 도구 허용, Agent 도구 허용 |
| depth 2 grandchild | read-only 전용, Agent 도구 금지, maxTurns 3, timeout 60s |
| 권한 상속 | child 권한은 parent보다 강해지면 안 됨 |
| abort 전파 | parent abort → child abort → grandchild abort (3계층) |
| non-interactive child | write 요청은 자동 deny |
| 병렬 workstream | owned/non-owned path 경계를 prompt에 명시하고, non-owned write는 경고/ask/deny 후보로 취급 |
| background verifier | `CORELINE_AUTO_VERIFY` opt-in 경로만 사용하며 user turn을 blocking하지 않음 |
| worktree helper | 자동 merge/push/rebase 금지, path traversal/비-git 디렉토리는 safe failure |

## 6. 프록시 안전 규칙

| 규칙 | 설명 |
|------|------|
| 기본 호스트 | `127.0.0.1` (localhost only) |
| 인증 | `--auth-token` 또는 `PROXY_AUTH_TOKEN`으로 bearer auth 설정 가능 |
| humanInputMode | `return` → 409, `forbid`/미설정 → 400 |
| hosted tools | 지원하지 않는 프로바이더에 전달하면 명시적 에러 반환 |
| batch 제한 | `maxBatchItems`, `maxBatchConcurrency`, `batchTimeoutMs` 설정 |

## 7. 메모리 규칙

| 규칙 | 설명 |
|------|------|
| AGENT.md 로딩 | memory 시스템과 독립. `loadProjectInstructions(cwd)` 단독 호출 가능 |
| 자동 요약 | 3턴 이상 정상 종료 시 중요 정보 자동 추출. `--no-auto-summary`로 비활성화 |
| 저장 경로 | `~/.coreline-agent/projects/{projectId}/memory/` |
| 민감 정보 | API 키, 비밀번호 등을 MemoryWrite로 저장하지 않음. `src/memory/safety.ts` secret scanner는 값이 아닌 label만 반환해야 함 |

## 8. 문서 Source-of-truth 규칙

| 문서 | 역할 |
|------|------|
| `README.md` | 사용자 기능, CLI/TUI/proxy 사용법의 1차 기준 |
| `AGENTS.md` | 에이전트가 이 저장소를 수정할 때 따르는 개발 규칙 |
| `docs/implementation-status.md` | 현재 구현 기준선, archived plan, 의도적 후속 항목 |
| `dev-plan/implement_*.md` | 작업 단위별 계획/완료 기록 |
| `docs/README.md` | docs 디렉토리 탐색용 index |

규칙:

- 미구현 여부는 `docs/implementation-status.md`와 최신 `dev-plan/implement_*.md`를 우선 확인한다.
- 오래된 `docs/impl-plan-*.md`는 archive/superseded 기록이며 active TODO가 아니다.
- 기능을 추가하면 README 사용법, AGENTS 개발 규칙, 관련 docs/status 중 필요한 문서를 함께 갱신한다.
- 문서와 코드가 충돌하면 `src/**` + `tests/**` + 최신 dev-plan을 기준으로 문서를 수정한다.

## 9. dev-plan 규칙

- 파일명: `dev-plan/implement_YYYYMMDD_HHMMSS.md`
- 필수 섹션: `개발 목적`, `개발 범위`, `제외 범위`, `참조 문서`, `공통 진행 규칙`
- Phase별 체크박스로 진행 추적
- 기존 dev-plan 파일은 덮어쓰지 않고 새로 생성
- Phase 완료 조건: 자체 테스트 통과 + typecheck clean
- 오래된 `docs/impl-plan-*.md`는 archive/superseded 기록이며 active TODO 기준은 `docs/implementation-status.md`와 최신 `dev-plan/*.md`

## 10. 테스트 네이밍

| 패턴 | 예시 |
|------|------|
| 프로바이더 테스트 | `tests/phase1-providers.test.ts` |
| 도구 테스트 | `tests/phase2-tools.test.ts`, `tests/file-tools-safety.test.ts`, `tests/mcp-resources.test.ts`, `tests/todo-write.test.ts`, `tests/ask-user-question.test.ts` |
| 권한 테스트 | `tests/phase3-permissions.test.ts` |
| 에이전트 루프 | `tests/phase4-agent-loop.test.ts` |
| 기능별 테스트 | `tests/{feature}.test.ts` (예: `proxy-router.test.ts`, `memory-auto-summary.test.ts`) |
| 프록시 테스트 | `tests/proxy-*.test.ts` |
| 원격 에이전트 | `tests/remote-agent-*.test.ts` |

## 11. 환경 변수

| 변수 | 용도 | 필수 |
|------|------|:----:|
| `ANTHROPIC_API_KEY` | Anthropic 프로바이더 | providers.yml 미설정 시 |
| `OPENAI_API_KEY` | OpenAI 프로바이더 | providers.yml 미설정 시 |
| `GOOGLE_API_KEY` | Gemini 프로바이더 | providers.yml 미설정 시 |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth 인증 | API key 대체용 |
| `PROXY_PORT` | 프록시 포트 (기본 4317) | 선택 |
| `PROXY_HOST` | 프록시 호스트 (기본 127.0.0.1) | 선택 |
| `PROXY_AUTH_TOKEN` | 프록시 bearer 인증 | 선택 |
| `CORELINE_NO_AUTO_SUMMARY` | 자동 메모리 요약 비활성화 (`1`) | 선택 |
| `CODEX_AUTH_PATH` | Codex backend OAuth 파일 경로 override | 선택 |
| `CODEX_CONFIG_PATH` | Codex backend `config.toml` 경로 override | 선택 |


## 12. 내장 스킬 규칙

| 규칙 | 설명 |
|------|------|
| 성격 | 스킬은 도구가 아니라 작업 절차 프롬프트다. |
| 권한 | 스킬은 PermissionEngine deny/ask, HookEngine blocking, Reliability guard를 우회하지 못한다. |
| 자동 선택 | root agent에서만 deterministic local router로 보수적으로 선택한다. |
| 비전파 | sub-agent는 자동 라우터를 재실행하지 않고 parent guidance만 받는다. |
| 라우터 입력 | code block, quote, tool result, replay/transcript, `@file` 확장 본문은 제외한다. |
| v1 스킬 | `dev-plan`, `parallel-dev`, `investigate`, `code-review` |

CLI/TUI 제어:

```bash
coreline-agent --list-skills
coreline-agent --show-skill dev-plan
coreline-agent -p "review src" --skill code-review --no-auto-skills
```

```txt
/skill list
/skill show dev-plan
/skill use dev-plan,parallel-dev
/skill auto off
/skill clear
/skill status
```
