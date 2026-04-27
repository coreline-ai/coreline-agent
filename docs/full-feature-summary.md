# coreline-agent 전체 기능 요약

> 최종 업데이트: 2026-04-26
> 소스 코드: 54,280 LOC / 286 files
> 테스트: 1504 pass / 205 files / 5,442 expects
> dev-plan: 45개 완료 / 0개 미착수

---

## 1. LLM 프로바이더 (9종)

| 프로바이더 | 타입 | 인증 | Tool Calling | Streaming |
|---|---|---|---|---|
| Anthropic (Claude) | SDK | API key / OAuth | ✅ | ✅ |
| OpenAI (GPT) | SDK | API key | ✅ | ✅ |
| Gemini | SDK | API key | ✅ | ✅ |
| Codex Backend | fetch | OAuth (`~/.codex/auth.json`, `CODEX_AUTH_PATH`) | ✅ | ✅ |
| Gemini Code Assist | fetch | OAuth (~/.gemini/oauth_creds.json) | ✅ | ✅ |
| OpenAI Compatible | fetch | API key / none (Ollama, vLLM) | ✅ | ✅ |
| Claude CLI | Bun.spawn | 로컬 바이너리 | ❌ | ❌ |
| Gemini CLI | Bun.spawn | 로컬 바이너리 | ❌ | ❌ |
| Codex CLI | Bun.spawn | 로컬 바이너리 | ❌ | ❌ |

---

## 2. 내장 도구

| 도구 | 권한 | 기능 |
|---|---|---|
| Bash | ask | 셸 명령 실행 + quote-aware/parser V2 안전 분류 |
| FileRead | allow | 파일 읽기 + blocked device path 보호 |
| FileWrite | ask | 파일 생성/덮어쓰기 + 자동 백업 |
| FileEdit | ask | 문자열 치환 편집 + 자동 백업 + diff 미리보기 + encoding/quote 안전화 |
| Glob | allow | 파일 패턴 검색 |
| Grep | allow | 파일 내용 정규식 검색 |
| MemoryRead | allow | 프로젝트 메모리 읽기 |
| MemoryWrite | ask | 프로젝트 메모리 저장 + secret scanner 보호 |
| Agent | allow* | 서브에이전트 위임 (write child는 ask) |
| Git | allow/ask | git status/diff/log/show/apply/stage/commit |
| TodoWrite | allow | 세션 체크리스트 업데이트/clear |
| AskUserQuestion | allow | TUI 구조화 multiple-choice 질문 |
| ListMcpResources | allow | MCP resource descriptor 목록 |
| ReadMcpResource | allow | MCP text/blob resource 읽기 + blob 저장 |
| MCP:* | ask | 동적 MCP 서버 브릿지 도구 |

---

## 3. 프록시 서버

### 엔드포인트

| 엔드포인트 | 용도 |
|---|---|
| `GET /health` | 프로바이더 인벤토리 |
| `GET /v1/providers` | 프로바이더 상세 (type/model/capabilities) |
| `GET /v2/capabilities` | 전체 capability matrix + batch 제한 |
| `GET /v2/status` | 에이전트 실행 상태 + hook 발견 |
| `POST /v1/messages` | Anthropic Messages API 호환 |
| `POST /v1/chat/completions` | OpenAI Chat Completions 호환 |
| `POST /v1/responses` | OpenAI Responses API 호환 (Codex CLI용) |
| `POST /v2/batch` | 멀티 아이템 배치 디스패치 |
| `POST /hook/coreline/*` | clideck 상태 감지 hook (start/stop/idle) |

### 기능

| 기능 | 상태 |
|---|---|
| 모델 이름 자동 라우팅 | ✅ (exact → prefix → default) |
| Streaming (SSE) | ✅ |
| Hosted tools passthrough | ✅ (web_search, code_execution) |
| humanInputMode | ✅ (return/forbid) |
| Bearer auth | ✅ (optional) |
| Request tracing (X-Request-Id) | ✅ |
| CORS | ✅ |

---

## 4. 에이전트 위임 (AgentTool)

| 기능 | 상태 |
|---|---|
| 단일 child 위임 | ✅ |
| 병렬 subtasks (coordinator) | ✅ |
| 순차 pipeline (handoff chain) | ✅ |
| Depth-2 재귀 (grandchild) | ✅ (read-only, Agent 금지) |
| Child provider/model override | ✅ |
| Write child (승인 필수) | ✅ |
| Debug/transcript 기록 | ✅ |
| 소유권 (ownedPaths/nonOwnedPaths) | ✅ |
| 계약 (contracts/mergeNotes) | ✅ |
| Partial failure 보고 | ✅ |
| Abort 3계층 전파 | ✅ |

---

## 5. Parallel Agent Runtime

| 기능 | 상태 |
|---|---|
| Background child task | ✅ |
| Task registry (등록/조회/중단) | ✅ |
| Scheduler (windowed parallelism) | ✅ (max 4, 1~8 설정) |
| Progress sink (lastActivity, toolUseCount) | ✅ |
| Policy envelope (소유권/도구/지시문 경계) | ✅ |
| Structured result 수집 | ✅ |
| `/agents`, `/agent status/read/stop` | ✅ |
| Sync/background abort scope 분리 | ✅ |
| Terminal task retention (최근 50) | ✅ |
| Verification task (`/verify`) | ✅ |

---

## 6. Plan & Goal 모드

| 기능 | 상태 |
|---|---|
| `--plan-mode` / `/plan` | ✅ |
| `--goal-mode` / `/goal` | ✅ |
| Task 상태 관리 (pending→running→verified→completed) | ✅ |
| 결정적 검증 우선 (exit code, file check, test pass) | ✅ |
| Re-planner (실패 task tail 재계획) | ✅ |
| Retry budget | ✅ |
| Recovery action (retry/replan/ask-user/stop) | ✅ |
| Goal resume (`--resume`) | ✅ |
| Autopilot loop | ✅ |

---

## 7. 메모리 시스템

| 기능 | 상태 |
|---|---|
| AGENT.md / CLAUDE.md 로딩 (memory 독립) | ✅ |
| 프로젝트별 메모리 (`~/.coreline-agent/projects/`) | ✅ |
| MemoryRead / MemoryWrite 도구 | ✅ |
| 자동 요약 (대화 종료 시 durable keyword 추출) | ✅ |
| `--no-auto-summary` 비활성화 | ✅ |
| High-confidence secret scanner/redaction | ✅ |

---

## 8. MCP 통합

| 기능 | 상태 |
|---|---|
| stdio MCP 서버 브릿지 | ✅ |
| `~/.coreline-agent/mcp.yml` 설정 | ✅ |
| 도구 네임스페이스 (serverName:toolName) | ✅ |
| 정책 게이팅 (ask) | ✅ |
| `resources/list`, `resources/read` | ✅ |
| blob/base64 resource tool-result 저장 | ✅ |

---

## 9. Remote Agent

| 기능 | 상태 |
|---|---|
| HTTP client (Anthropic Messages API) | ✅ |
| RemoteScheduler (windowed parallelism) | ✅ |
| Round-robin + health tracking | ✅ |
| Retry with exponential backoff | ✅ |
| Abort 전파 | ✅ |
| RemoteSubAgentRuntime (SubAgentRuntime 호환) | ✅ |
| Remote pipeline | ✅ |

---

## 10. Hook Engine

| 기능 | 상태 |
|---|---|
| 이벤트: StatusChange, PreTool, PostTool, SessionStart/End | ✅ |
| Function hook | ✅ |
| HTTP hook (localhost-only 기본) | ✅ |
| Command hook safe runner (internal opt-in, disabled by default) | ✅ |
| Blocking 규약 (명시적 `blocking: true`만 차단) | ✅ |
| Fail-open 정책 | ✅ |
| PreTool permission adapter + PostTool dispatch | ✅ |
| Lifecycle cleanup (idempotent destroy) | ✅ |

---

## 11. 신뢰도 레이어

| 기능 | 상태 |
|---|---|
| CompletionJudge (완료/부분/차단/확인필요 판정) | ✅ |
| AgentTraceRecord (판단 근거 감사 로그) | ✅ |
| RecoveryCheckpoint + ResumeAdvice | ✅ |
| VerificationPack (증거 묶음) | ✅ |
| Benchmark runner (mock-first quality smoke) | ✅ |

---

## 12. 파일 안전성

| 기능 | 상태 |
|---|---|
| 자동 백업 (FileWrite/FileEdit 전) | ✅ |
| `/undo` 복원 | ✅ |
| Diff 미리보기 (FileEdit 결과에 unified diff) | ✅ |
| 멀티파일 트랜잭션 (begin/commit/rollback) | ✅ |
| FileRead blocked device path 차단 | ✅ |
| FileEdit no-op/대용량/UTF-16LE/quote normalization 보호 | ✅ |
| FileEdit binary/null-byte 거부 + atomic temp-write | ✅ |
| FileRead→FileEdit read-before-write / stale-write guard | ✅ |
| write-capable 경로 hardening + symlink/realpath 보호 | ✅ |

---

## 13. 비용 / 실행 관리

| 기능 | 상태 |
|---|---|
| 비용 추적 ($ per model, unknown pricing 표시) | ✅ |
| `--budget` 예산 제한 | ✅ |
| 상태바 provider/model/reasoning/cost/quota 표시 | ✅ |
| 테스트 자동 루프 (`--test-loop`, `/test-loop`) | ✅ |
| Fork Verifier (`/verify` background typecheck+build+test) | ✅ |
| Watchdog (idle timeout) | ✅ |
| 대용량 tool result 파일 저장 + preview | ✅ |
| 자기 수정 힌트 (도구 실패 시 대안 접근 컨텍스트) | ✅ |
| 적응형 프롬프트 (도구 사용 패턴 기반 팁) | ✅ |

---

## 14. TUI / CLI 기능

| 기능 | 상태 |
|---|---|
| Ink 5 / React 18 TUI | ✅ |
| 상태바 (provider/model/tokens/cost/turns/proxy/working) | ✅ |
| Streaming 출력 + markdown 렌더링 | ✅ |
| Tool result 축약/확장 | ✅ |
| Permission prompt (ask/allow/deny) | ✅ |
| Reasoning 표시 on/off | ✅ |
| Provider switch (Ctrl+P) | ✅ |
| Session resume (`--resume`) | ✅ |
| @file 첨부 (`@src/index.ts`, `@*.ts`) | ✅ |
| Session export (markdown/text/pr) | ✅ |

---

## 15. 개발 생산성

| 기능 | 상태 |
|---|---|
| Scaffold (`/scaffold tool/provider/test`) | ✅ |
| Context Snip (의미 단위 컨텍스트 우선 압축) | ✅ |
| Runtime Tweaks (`/set`, `/reset`) | ✅ |
| 역할 프리셋 (`--role`, `/role`) | ✅ |
| 프롬프트 라이브러리 (`/prompt save/list/use/delete`) | ✅ |
| 트랜스크립트 검색 (`/search`) | ✅ |
| 세션 리플레이 (`/replay`) | ✅ |
| Built-in 스킬 (dev-plan, parallel-dev, investigate, code-review) | ✅ |
| Rate limit 헤더 파싱 + 선제적 throttle | ✅ |

---

## 16. 외부 연동

| 기능 | 상태 |
|---|---|
| clideck preset 지원 (agent-presets.json) | ✅ |
| clideck hook (start/stop/idle) | ✅ |
| status.json 파일 기반 상태 노출 | ✅ |
| 프록시 `/v2/status` HTTP 상태 노출 | ✅ |

---

## 17. 설정 파일

| 파일 | 경로 | 용도 |
|---|---|---|
| providers.yml | `~/.coreline-agent/providers.yml` | 프로바이더 설정 |
| config.yml | `~/.coreline-agent/config.yml` | 런타임 설정 (theme, maxTurns, defaultProvider) |
| permissions.yml | `~/.coreline-agent/permissions.yml` | 도구 권한 규칙 |
| roles.yml | `~/.coreline-agent/roles.yml` | 역할 프리셋 |
| mcp.yml | `~/.coreline-agent/mcp.yml` | MCP 서버 설정 |
| system-prompt.md | `~/.coreline-agent/system-prompt.md` | 커스텀 시스템 프롬프트 |
| prompts/ | `~/.coreline-agent/prompts/` | 프롬프트 라이브러리 |
| backups/ | `~/.coreline-agent/backups/` | 파일 백업 |
| status.json | `~/.coreline-agent/status.json` | 에이전트 실행 상태 |

---

## 18. TUI 슬래시 명령 전체

| 명령 | 기능 |
|---|---|
| `/plan <goal>` | 계획 모드 실행 |
| `/goal <goal>` | 목표 모드 실행 |
| `/autopilot` | 오토파일럿 모드 |
| `/role <name>` | 역할 전환 (reviewer, planner, coder) |
| `/prompt save <name>` | 마지막 입력을 프롬프트로 저장 |
| `/prompt list` | 저장된 프롬프트 목록 |
| `/prompt use <name>` | 프롬프트 불러오기 |
| `/prompt delete <name>` | 프롬프트 삭제 |
| `/search <query>` | 세션 트랜스크립트 검색 |
| `/replay [sessionId]` | 세션 리플레이 |
| `/scaffold <kind> <name>` | 도구/프로바이더/테스트 boilerplate 생성 |
| `/set <key> <value>` | 런타임 설정 변경 |
| `/set` | 현재 설정 목록 표시 |
| `/reset <key>` | 설정 기본값 복원 |
| `/verify` | typecheck+build+test background 검증 |
| `/undo` | 마지막 파일 편집 복원 |
| `/test-loop [command]` | 테스트 자동 수정 루프 |
| `/agents` | background task 목록 |
| `/agent status <id>` | task 상태 확인 |
| `/agent read <id>` | task 결과 읽기 |
| `/agent stop <id>` | task 중단 |
| `/eval` | 작업 결과 자기 평가 |
| `/export md` | 세션 마크다운 내보내기 |
| `/skill <name>` | 스킬 조회/활성화 |
| `/theme` | 대화형 테마 선택기 (↑/↓ 네비게이션) |
| `/theme <id>` | 즉시 테마 전환 + config.yml 저장 |
| `/theme list` | 지원 테마 10종 목록 출력 |

---

## 19. CLI 옵션 전체

| 옵션 | 기능 |
|---|---|
| `-p, --prompt <text>` | 단발 실행 후 종료 |
| `--provider <name>` | 프로바이더 지정 |
| `--model <id>` | 모델 지정 |
| `--role <name>` | 역할 프리셋 적용 |
| `--plan-mode` | 계획 모드 |
| `--goal-mode` | 목표 모드 |
| `--test-loop` | 테스트 자동 루프 |
| `--budget <dollars>` | 세션 예산 제한 |
| `--resume [sessionId]` | 세션 재개 |
| `--json` | NDJSON 출력 |
| `--verbose` | 디버그 로깅 |
| `--show-reasoning` | reasoning 표시 |
| `--no-reasoning` | reasoning 숨김 |
| `--no-auto-summary` | 자동 메모리 요약 비활성화 |
| `--max-turns <n>` | 최대 턴 수 |
| `--proxy [url]` | 프록시 연결/기동 |
| `-v, --version` | 버전 표시 |

---

## 3-Tier Memory (메모리 레퍼런스 integration)

메모리 레퍼런스 포트로 3단계 메모리 티어링을 지원한다. `core`는 항상 system prompt에 주입되는 hot working set, `recall`은 working set 한도 내 최신 접근순 선택, `archival`은 `MemoryRecall` 도구로만 조회된다. 자동 승격(accessCount ≥ 3 → core), 자동 컴팩션(오래된/저중요도 → archival), MEMORY.md 디제스트 생성, 세션별 크로스-세션 recall 인덱싱을 제공한다.

- 슬래시 명령: `/memory digest`, `/memory compact`, `/memory promote`
- 환경 변수: `CORELINE_WORKING_SET_LIMIT`, `CORELINE_AUTO_PROMOTE`, `CORELINE_DEBUG_PROMPT`
- 관련 문서: [memory-system.md](memory-system.md), [memkraft-integration.md](memkraft-integration.md)

## Self-Improvement Loop

각 스킬/서브에이전트/프롬프트/플랜-이터레이션 실행은 append-only JSONL evidence 로그로 기록된다. `summariseEval`이 pass rate·평균 tool use·unclear points를 집계하고, `checkConvergence`가 N회 윈도우 안정성을 판정하여 plan loop에 자동 정지 신호를 전송한다. tier-aware staleness (`TIER_STALE_DAYS` — core 180d, recall 60d, archival ∞)로 장기 진화 추적이 가능하다.

- 슬래시 명령: `/skill stats`, `/subagent stats`, `/prompt evidence`, `/prompt experiment`
- 환경 변수: `CORELINE_DISABLE_CONVERGENCE_AUTOSTOP`
- 관련 문서: [memkraft-integration.md](memkraft-integration.md)
