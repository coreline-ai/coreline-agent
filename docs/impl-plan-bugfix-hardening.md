# Implementation Plan: Code Review Bugfix & Hardening

## 문서 동기화 상태 (2026-04-19)

- 상태: **ARCHIVED / SUPERSEDED**
- 현재 기준: 초기 코드리뷰 bugfix/hardening 체크리스트입니다. 현재 보안/프로바이더/TUI 수정은 실제 코드와 fix-* 테스트로 검증됩니다.
- Source of truth: `tests/fix-*.test.ts, tests/phase*.test.ts, src/permissions/*, src/providers/*, src/tui/*`
- 아래 체크리스트는 **활성 TODO가 아니라 과거 구현 계획 기록**입니다.
- 혼동 방지를 위해 미완료 체크박스 표기는 `(historical task)`로 변환했습니다.
- 현재 미구현/후속 항목은 `docs/implementation-status.md`와 최신 `dev-plan/implement_*.md`를 기준으로 판단합니다.

---


> 코드 리뷰에서 발견된 CRITICAL 5, HIGH 5, MEDIUM 10개 이슈를 Phase A/B/C로 나눠 수정 + 테스트 강화
> Generated: 2026-04-11
> Project: coreline-agent

---

## 1. Context (배경)

### 1.1 Why (왜 필요한가)
- 코드 리뷰에서 **프로바이더 스트리밍 버그** (Anthropic tool ID, Gemini 매핑, SSE 파서) 발견
- **보안 분류기 우회** (echo 리다이렉트, 파이프 체인) 발견
- **세션 미저장** (TUI 모드), **React 상태 관리 오류** 등 구조적 이슈
- 테스트 커버리지 67개 → 프로바이더·도구 엣지케이스 대부분 미검증

### 1.2 Current State (현재 상태)
- Phase 0~7 완료, 67 테스트 통과
- 4개 프로바이더 어댑터에 스트리밍 버그 존재
- 보안 분류기에 리다이렉트/파이프 우회 경로 존재
- TUI에서 세션 저장 불가, 프로바이더 전환 시 UI 미갱신

### 1.3 Target State (목표 상태)
- CRITICAL/HIGH 이슈 0건
- 프로바이더 어댑터 멀티 tool call 정상 처리
- 보안 분류기 우회 차단
- TUI 세션 저장 + 프로바이더 전환 정상 동작
- 테스트 110개+

### 1.4 Scope Boundary (범위)
- **In scope**: 리뷰에서 발견된 C1~C5, H1~H5, M1~M10 수정 + 테스트 추가
- **Out of scope**: 신규 기능 추가, MCP 지원, 플러그인 시스템

---

## 2. Architecture Overview (아키텍처)

### 2.1 변경 영역 다이어그램

```
providers/
  anthropic.ts     ← C1,C2: tool ID tracking 재설계
  gemini.ts        ← C3: ID→functionName 매핑
  openai-compatible.ts ← C4: SSE buffer flush, M1: reader 해제

agent/
  loop.ts          ← H3: JSON 에러 yield, H5: dead import 제거

tui/
  app.tsx          ← C5: SessionManager prop 추가
  repl.tsx         ← C5: 세션 저장 연동, H4: provider React state

permissions/
  classifier.ts   ← H1: 리다이렉트 검사, H2: 파이프 후속 명령 검사
  engine.ts        ← M4: 시스템 경로 확장, M7: glob 정규식 수정

tools/
  file-read-tool.ts  ← M2: 이미지 base64 반환
  file-edit-tool.ts  ← M3: 에러 메시지 구분

config/schema.ts     ← M9: apiKey 런타임 검증
session/storage.ts   ← M8: 파싱 에러 로깅
utils/stdin.ts       ← M5: 타임아웃 확대, M6: 리스너 정리
index.ts             ← C5: session → TUI 전달
```

### 2.2 Key Design Decisions

| 결정 사항 | 선택 | 근거 |
|-----------|------|------|
| Anthropic tool ID | `event.index` → block ID 매핑 테이블 | Claude Code 동일 패턴 |
| Gemini tool ID | `Map<syntheticId, functionName>` 인스턴스 변수 | 라운드트립 보장 |
| SSE 파서 수정 | loop 후 buffer 잔여분 처리 | 데이터 유실 방지 |
| Provider state | `useState<LLMProvider>` | React 렌더 사이클 보장 |
| classifier 보안 | 리다이렉트·파이프 후속 명령 패턴 추가 | 우회 차단 |

### 2.3 Modified Files (수정 파일)

| 파일 경로 | 변경 내용 |
|-----------|-----------|
| `src/providers/anthropic.ts` | tool ID tracking 재설계 (C1,C2) |
| `src/providers/gemini.ts` | syntheticId↔functionName 매핑 (C3) |
| `src/providers/openai-compatible.ts` | SSE buffer flush + reader 해제 (C4,M1) |
| `src/agent/loop.ts` | JSON 에러 yield + dead import 제거 (H3,H5) |
| `src/tui/app.tsx` | SessionManager prop 추가 (C5) |
| `src/tui/repl.tsx` | 세션 저장 + provider useState (C5,H4) |
| `src/permissions/classifier.ts` | 리다이렉트+파이프 검사 (H1,H2) |
| `src/permissions/engine.ts` | 시스템 경로 확장 + regex 수정 (M4,M7) |
| `src/tools/file-read/file-read-tool.ts` | base64 실제 반환 (M2) |
| `src/tools/file-edit/file-edit-tool.ts` | 에러 구분 메시지 (M3) |
| `src/config/schema.ts` | apiKey 경고 로직 (M9) |
| `src/session/storage.ts` | 파싱 에러 stderr 로깅 (M8) |
| `src/utils/stdin.ts` | 타임아웃 10초 + 리스너 개별 해제 (M5,M6) |
| `src/index.ts` | session → launchTUI 전달 (C5) |

### 2.4 New Files (신규 파일)

| 파일 경로 | 용도 |
|-----------|------|
| `tests/fix-providers.test.ts` | 프로바이더 어댑터 수정 검증 |
| `tests/fix-security.test.ts` | 분류기·권한 보안 수정 검증 |
| `tests/fix-tui-session.test.ts` | TUI 세션·상태 수정 검증 |
| `tests/fix-tools-edge.test.ts` | 도구 엣지케이스 테스트 |

---

## 3. Phase Dependencies (페이즈 의존성)

```
Phase A (CRITICAL + HIGH 보안)
    │
    ├── Phase A1 (프로바이더 버그) ─┐
    │                               │ ← 병렬 가능
    ├── Phase A2 (보안 분류기)  ────┤
    │                               │
    └── Phase A3 (세션 + 상태) ─────┘
                                    │
                                    ▼
Phase B (HIGH 나머지 + MEDIUM)
    │
    ├── Phase B1 (에이전트 루프) ───┐
    │                               │ ← 병렬 가능
    └── Phase B2 (도구 + 설정)  ────┘
                                    │
                                    ▼
Phase C (테스트 강화)
```

---

## 4. Implementation Phases (구현 페이즈)

### Phase A1: Provider Streaming Bugs (프로바이더 스트리밍 버그)
> C1, C2, C3, C4, M1 수정
> Dependencies: 없음

#### Tasks
- (historical task) `src/providers/anthropic.ts` — `content_block_start`에서 `event.index → block.id` 매핑 테이블(`blockIdByIndex: Map<number, string>`) 추가. `input_json_delta` 핸들러(line 167-179)에서 `event.index`로 실제 ID 조회하여 `tool_call_delta` emit
- (historical task) `src/providers/anthropic.ts` — `content_block_stop` 핸들러(line 183-191) 수정: `event.index`로 해당 block이 tool_use인지 확인 후 해당 ID만 `tool_call_end` emit. `message_stop`에서 `activeToolInputs.clear()` 및 `blockIdByIndex.clear()`
- (historical task) `src/providers/gemini.ts` — 클래스에 `private toolIdMap = new Map<string, string>()` 추가. `send()`의 functionCall 핸들러(line 189-202)에서 `toolIdMap.set(syntheticId, functionName)` 저장
- (historical task) `src/providers/gemini.ts` — `convertMessages()`의 `tool_result` 변환(line 42-48)에서 `block.toolUseId`가 `gemini_tc_` prefix이면 `toolIdMap`에서 원래 function name 조회하여 `functionResponse.name`에 사용
- (historical task) `src/providers/openai-compatible.ts` — `parseSSEStream()`(line 143-169) for-await 루프 종료 후 `buffer` 잔여분 처리: `if (buffer.trim().startsWith("data: "))` → 파싱 시도
- (historical task) `src/providers/openai-compatible.ts` — `send()` 메서드에서 reader를 `try/finally`로 감싸서 `reader.releaseLock()` 호출 (M1)

#### Success Criteria
- Anthropic 멀티 tool call (2개 이상) 시 각 tool의 input이 정확히 분리되어 수집
- Gemini tool result 회신 시 원래 function name 사용
- SSE 스트림이 `\n`으로 끝나도 마지막 chunk 유실 없음
- reader가 에러 시에도 해제됨

#### Test Cases
- (historical task) TC-A1.1: Anthropic 어댑터 — 2개 tool_use block 스트림 → 각 tool의 inputJson이 정확히 분리
- (historical task) TC-A1.2: Anthropic 어댑터 — text block + tool_use block 혼합 → `content_block_stop`이 text에서 tool_call_end를 발화하지 않음
- (historical task) TC-A1.3: Gemini 어댑터 — tool call 후 result 회신 시 function name이 원래 이름과 일치
- (historical task) TC-A1.4: OpenAI-compatible SSE — `"data: {}\n"` (마지막 줄 `\n` 종료) → chunk 유실 없음
- (historical task) TC-A1.5: OpenAI-compatible SSE — 스트림 중간 에러 → reader.releaseLock() 호출 확인
- (historical task) TC-A1.E1: Anthropic — 빈 input_json_delta → 빈 문자열 누적 (크래시 아님)
- (historical task) TC-A1.E2: Gemini — toolIdMap에 없는 ID로 결과 회신 → fallback으로 toolUseId 그대로 사용

#### Testing Instructions
```bash
bun test tests/fix-providers.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase A2: Security Classifier Hardening (보안 분류기 강화)
> H1, H2, M4, M7 수정
> Dependencies: 없음
> **Phase A1과 병렬 진행 가능**

#### Tasks
- (historical task) `src/permissions/classifier.ts` — `classifyBashCommand()` 함수 상단에 **리다이렉트 검사** 추가: `>`, `>>`, `2>` 연산자가 포함된 명령은 READ_ONLY에서 제외. 정규식 `/[^2]?>|>>|2>/` 패턴 사전 검사
- (historical task) `src/permissions/classifier.ts` — 파이프 체인 검사(line 125-131) 강화: 파이프 후속 명령에서 `tee`, `dd`, `cp`, `mv`, `install`, `scp` 등 쓰기 명령 감지 시 `ask` 반환
- (historical task) `src/permissions/engine.ts` — `SYSTEM_DENY_PATHS`(line 15-19) 확장: `/proc`, `/sys`, `/dev` (단 `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` 제외), `/root`, `/boot`, `/etc/ssl` 추가
- (historical task) `src/permissions/engine.ts` — `matchesRule()` regex 생성(line 40-44) 수정: `escapeRegex()` 헬퍼 함수로 분리, 문자 클래스 이스케이프 순서 수정 (`]`를 첫 번째에 배치)

#### Success Criteria
- `echo "data" > /tmp/file` → `ask` (allow가 아님)
- `cat /etc/passwd | tee /tmp/stolen` → `ask`
- `/proc/self/environ` 쓰기 시도 → `deny`
- `test[1]*.ts` 패턴 매칭 정상 동작

#### Test Cases
- (historical task) TC-A2.1: `echo hello` (리다이렉트 없음) → `allow`
- (historical task) TC-A2.2: `echo "data" > /tmp/file` → `ask`
- (historical task) TC-A2.3: `echo "data" >> /tmp/file` → `ask`
- (historical task) TC-A2.4: `cat foo | grep bar` → `allow` (안전 파이프)
- (historical task) TC-A2.5: `cat foo | tee /tmp/out` → `ask` (쓰기 파이프)
- (historical task) TC-A2.6: `ls | dd of=/dev/sda` → `ask`
- (historical task) TC-A2.7: `/proc/self/environ` 파일 쓰기 → `deny`
- (historical task) TC-A2.8: `/dev/null` 리다이렉트 → `allow` (안전한 /dev 예외)
- (historical task) TC-A2.9: 패턴 `test[1]*.ts` → glob 매칭 정상
- (historical task) TC-A2.E1: 빈 명령 → `ask`
- (historical task) TC-A2.E2: null/undefined 입력 → 에러 없이 `deny`

#### Testing Instructions
```bash
bun test tests/fix-security.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase A3: Session & TUI State (세션 저장 + 상태 관리)
> C5, H4 수정
> Dependencies: 없음
> **Phase A1, A2와 병렬 진행 가능**

#### Tasks
- (historical task) `src/tui/app.tsx` — `AppProps` 인터페이스(line 11-16)에 `session?: SessionManager` 추가. `<REPL>` 컴포넌트에 `session` prop 전달
- (historical task) `src/tui/repl.tsx` — `REPLProps`에 `session?: SessionManager` 추가. `handleSubmit()` 내에서 user message 전송 시 `session?.saveMessage(userMsg)` 호출, assistant 응답 완료 시 `session?.saveMessage(assistantMsg)` 호출
- (historical task) `src/tui/repl.tsx` — `handleProviderSwitch()`(line 73-85)에서 `state.provider` 직접 mutation 대신 `useState<LLMProvider>` 도입: `const [currentProvider, setCurrentProvider] = useState(state.provider)`. StatusBar와 agentLoop에서 `currentProvider` 사용
- (historical task) `src/tui/repl.tsx` — REPL 초기화 시 `session?.loadMessages()`로 이전 메시지 복원. resumeId가 있으면 displayMessages에 반영
- (historical task) `src/index.ts` — `launchTUI()`(line 214-219) 호출 시 `session` 전달: `launchTUI({ state, providerRegistry, systemPrompt, maxTurns, session })`

#### Success Criteria
- TUI 대화형 모드에서 대화 3턴 → `~/.coreline-agent/sessions/` 에 JSONL 파일 생성, 6개 메시지 저장
- `--resume` 후 TUI 시작 시 이전 메시지 화면에 표시
- Ctrl+P 프로바이더 전환 시 StatusBar 즉시 갱신

#### Test Cases
- (historical task) TC-A3.1: SessionManager → REPL로 전달 확인 (prop 존재)
- (historical task) TC-A3.2: handleSubmit 호출 시 session.saveMessage 2회 호출 (user + assistant)
- (historical task) TC-A3.3: provider 전환 후 StatusBar의 providerName 변경 확인
- (historical task) TC-A3.4: resume 모드 → 이전 메시지 displayMessages에 로드
- (historical task) TC-A3.E1: session이 undefined → 저장 없이 정상 동작 (크래시 아님)

#### Testing Instructions
```bash
bun test tests/fix-tui-session.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase B1: Agent Loop Hardening (에이전트 루프 강화)
> H3, H5, M10 수정
> Dependencies: Phase A 완료

#### Tasks
- (historical task) `src/agent/loop.ts` — `import { runToolCalls }` (line 32) 제거 (dead code H5). 현재 inline 실행 로직 유지
- (historical task) `src/agent/loop.ts` — `buildAssistantMessage()`(line 120)과 tool execution(line 217)의 `try { JSON.parse } catch {}` 블록에서 catch 시 `yield { type: "error", error: new Error(\`Malformed tool input JSON for \${tc.name}: \${tc.inputJson.slice(0,100)}\`) }` 이벤트 발생 + `input = {}` 유지
- (historical task) `src/agent/loop.ts` — `driveStream()`의 `tool_call_delta` 핸들러(line 79-86)에서 `pending_` prefix fallback 제거. 대신 정확한 ID 매칭만 사용 (Anthropic 어댑터가 Phase A1에서 수정됨)

#### Success Criteria
- `tsc --noEmit` 에러 0건 (dead import 제거 후)
- 잘못된 JSON tool input → error 이벤트 yield + 빈 `{}` 으로 실행 (크래시 아님)
- `pending_` fallback 없이 정확한 ID 매칭

#### Test Cases
- (historical task) TC-B1.1: malformed JSON `"{ invalid"` → error 이벤트 yield + tool은 `{}` input으로 실행
- (historical task) TC-B1.2: 정상 JSON tool call → 기존 동작 유지
- (historical task) TC-B1.3: dead import 제거 후 tsc 통과
- (historical task) TC-B1.E1: 완전히 빈 inputJson `""` → `{}` 으로 안전 파싱

#### Testing Instructions
```bash
bun test tests/phase4-agent-loop.test.ts
npx tsc --noEmit
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase B2: Tools & Config Fixes (도구 + 설정 수정)
> M2, M3, M5, M6, M8, M9 수정
> Dependencies: Phase A 완료
> **Phase B1과 병렬 진행 가능**

#### Tasks
- (historical task) `src/tools/file-read/file-read-tool.ts` — 이미지 핸들러(line 66-79): `FileReadOutput`에 `base64?: string` 필드 추가. 이미지 파일 읽기 시 `data.base64 = buffer.toString("base64")` 저장. `formatResult()`에서 base64 포함 여부 표시
- (historical task) `src/tools/file-edit/file-edit-tool.ts` — `FileEditOutput`에 `errorReason?: "not_found" | "not_unique"` 필드 추가. count===0 시 `errorReason: "not_found"`, count>1 시 `errorReason: "not_unique"`. `formatResult()`에서 구분 메시지 출력
- (historical task) `src/utils/stdin.ts` — 타임아웃 1000ms → 10000ms (10초)로 변경. `removeAllListeners()` → `process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.off("error", onError)` 개별 해제
- (historical task) `src/session/storage.ts` — `loadSession()`(line 82-92)의 catch 블록에 `console.error(\`[session] Skipping malformed line in \${sessionId}: \${line.slice(0,50)}\`)` 추가
- (historical task) `src/config/schema.ts` — `parseProvidersFile()` 함수 끝에 apiKey 경고 로직 추가: `type !== "openai-compatible" && !apiKey && !process.env[...]` 시 `console.warn(\`[config] Provider "\${name}" has no apiKey — will fail at runtime\`)` 출력

#### Success Criteria
- 이미지 파일 읽기 → ToolResult에 base64 문자열 포함
- FileEdit 에러 시 "not found" vs "not unique" 구분 가능
- 10MB stdin pipe → 타임아웃 전 데이터 수신 완료
- session 파싱 에러 시 stderr에 경고 출력
- apiKey 누락 시 config 로드 단계에서 경고

#### Test Cases
- (historical task) TC-B2.1: PNG 파일 읽기 → `output.base64` 문자열 존재 + 길이 > 0
- (historical task) TC-B2.2: FileEdit `old_string` 미발견 → `errorReason === "not_found"`
- (historical task) TC-B2.3: FileEdit `old_string` 2개 이상 → `errorReason === "not_unique"`
- (historical task) TC-B2.4: stdin 10초 미만 대용량 데이터 → 전체 수신
- (historical task) TC-B2.5: session 깨진 JSONL → stderr 경고 + 정상 줄만 로드
- (historical task) TC-B2.E1: 빈 이미지 파일 (0 bytes) → base64 빈 문자열

#### Testing Instructions
```bash
bun test tests/fix-tools-edge.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase C: Test Coverage Expansion (테스트 강화)
> 미커버 영역 테스트 추가
> Dependencies: Phase A, Phase B 완료

#### Tasks
- (historical task) `tests/fix-providers.test.ts` — 프로바이더 메시지 변환 단위테스트 추가: `convertMessages()` 함수를 export하고 각 프로바이더별 user/assistant/tool_result 메시지 변환 검증 (최소 12개 케이스)
- (historical task) `tests/orchestration.test.ts` 신규 생성 — `partitionToolCalls()` 직접 단위테스트: 읽기 3개→병렬, 쓰기 2개→직렬, 혼합 시퀀스→3그룹, 빈 입력→빈 출력 (4개 케이스)
- (historical task) `tests/fix-tools-edge.test.ts` — 도구 엣지케이스 추가: 빈 파일 읽기, 존재하지 않는 디렉토리 glob, 유니코드 파일명, Bash stderr만 출력, Bash exit code 127 (5개 케이스)
- (historical task) `tests/fix-security.test.ts` — 보안 엣지케이스 추가: symlink path 검사, 여러 `>` 변형 (`2>&1`, `&>`), 복합 명령 (`cmd1 && cmd2`), 서브셸 `$()` 내 위험 명령 (4개 케이스)
- (historical task) 기존 테스트 파일 내 vacuous 테스트 수정 — `phase2-tools.test.ts`의 하드코딩된 `.toHaveLength(2)` → 동적 검증으로 변경

#### Success Criteria
- 전체 테스트 **95개 이상** 통과
- `npx tsc --noEmit` 에러 0건
- `bun test` 전체 통과

#### Test Cases
- (historical task) TC-C.1: 전체 테스트 스위트 실행 → 0 fail
- (historical task) TC-C.2: 각 프로바이더별 메시지 변환 → 입출력 정확 (12개)
- (historical task) TC-C.3: orchestration 파티셔닝 → 그룹 수/타입 정확 (4개)
- (historical task) TC-C.4: 도구 엣지케이스 → 에러 핸들링 정상 (5개)
- (historical task) TC-C.5: 보안 패턴 → 분류 정확 (4개)

#### Testing Instructions
```bash
bun test
npx tsc --noEmit
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

## 5. Integration & Verification (통합 검증)

### 5.1 Integration Test Plan
- (historical task) E2E-1: Anthropic mock → 멀티 tool call (Glob + FileRead) → 각 tool input 정확 + 세션 저장
- (historical task) E2E-2: `echo "data" > /tmp/test` 시도 → ask 프롬프트 → deny → LLM에 거부 사유 전달
- (historical task) E2E-3: TUI 시작 → 대화 3턴 → Ctrl+P 프로바이더 전환 → 4턴째 새 프로바이더로 응답
- (historical task) E2E-4: 비대화형 `-p "hello"` → 세션 파일 생성 → `--resume` → 이전 메시지 로드

### 5.2 Manual Verification Steps
1. `ANTHROPIC_API_KEY=... bun run src/index.ts` → TUI 기동
2. "파일 목록 보여줘" 입력 → Glob 호출 → 결과 표시
3. Ctrl+P → 프로바이더 전환 → StatusBar 갱신 확인
4. Ctrl+C → 종료 → `~/.coreline-agent/sessions/` 에 JSONL 확인
5. `bun run src/index.ts --resume` → 이전 대화 이어감

### 5.3 Rollback Strategy
- 각 Phase는 독립 커밋 → 문제 시 `git revert <commit>` 으로 롤백
- Phase A1/A2/A3은 서로 독립 → 개별 롤백 가능

---

## 6. Edge Cases & Risks (엣지 케이스 및 위험)

| 위험 요소 | 영향도 | 완화 방안 |
|-----------|--------|-----------|
| Anthropic SDK 버전 차이로 event 구조 변경 | 높음 | `event.index` 존재 여부 방어 코딩 |
| Gemini toolIdMap 메모리 누적 | 낮음 | `send()` 호출마다 새 Map 생성 |
| 파이프 체인 분석 복잡도 | 중간 | 위험 명령 화이트리스트 방식으로 단순화 |
| React state 전환 시 진행 중 요청 | 중간 | provider 전환은 idle 상태에서만 허용 (isLoading 체크) |
| stdin 10초 타임아웃도 부족한 경우 | 낮음 | 환경변수 `CORELINE_STDIN_TIMEOUT` 로 커스텀 가능하게 |

---

## 7. Execution Rules (실행 규칙)

1. **독립 모듈**: 각 Phase는 독립적으로 구현하고 테스트한다
2. **완료 조건**: 모든 태스크 체크박스 체크 + 모든 테스트 통과
3. **테스트 실패 워크플로우**: 에러 분석 → 근본 원인 수정 → 재테스트 → 통과 후에만 다음 Phase 진행
4. **Phase 완료 기록**: 체크박스를 체크하여 이 문서에 진행 상황 기록
5. **병렬 실행**: Phase A1 + A2 + A3 동시 진행 가능, Phase B1 + B2 동시 진행 가능
6. **기존 테스트 유지**: 수정 후 기존 67개 테스트 전부 통과해야 함
