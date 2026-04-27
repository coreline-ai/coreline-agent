# Implementation Plan: Multi-Provider Coding Agent TUI

## 문서 동기화 상태 (2026-04-19)

- 상태: **ARCHIVED / SUPERSEDED**
- 현재 기준: 초기 Multi-Provider Coding Agent TUI 설계 문서입니다. 현재 구현 기준은 README, AGENTS.md, dev-plan/*.md, 그리고 실제 테스트 스위트입니다.
- Source of truth: `README.md, AGENTS.md, dev-plan/implement_20260419_170411.md~171641.md`
- 아래 체크리스트는 **활성 TODO가 아니라 과거 구현 계획 기록**입니다.
- 혼동 방지를 위해 미완료 체크박스 표기는 `(historical task)`로 변환했습니다.
- 현재 미구현/후속 항목은 `docs/implementation-status.md`와 최신 `dev-plan/implement_*.md`를 기준으로 판단합니다.

---


> 다수의 LLM 프로바이더(Claude, OpenAI/Codex, Gemini, 로컬 LLM)를 URL 기반으로 자유롭게 연결하는 자율형 코딩 에이전트 CLI/TUI
> Generated: 2026-04-09
> Project: coreline-agent (가칭)
> Reference: Claude Code v2.1.88 sourcemap-extracted

---

## 1. Context (배경)

### 1.1 Why (왜 필요한가)

- 기존 코딩 에이전트(Claude Code, Cursor, Cline 등)는 **단일 프로바이더에 종속**
- 로컬 LLM(Ollama, LM Studio)과 클라우드 LLM을 **동일 인터페이스로 전환**하고 싶은 니즈 존재
- URL 하나로 사내 LLM, 오픈소스 LLM, 상용 API를 붙일 수 있는 **범용 에이전트** 부재

### 1.2 Current State (현재 상태)

- Claude Code 레퍼런스 소스 분석 완료 (512,785 LOC)
- 핵심 아키텍처 패턴 파악 완료:
  - Agent Loop: `query() → queryLoop() → callModel() → runTools() → continue`
  - Tool System: `buildTool()` 팩토리 + Zod 스키마 + `checkPermissions()` 체인
  - TUI: Ink 5 기반 React 렌더러 + 스트리밍 출력
  - API Client: 환경변수 기반 프로바이더 디스패치 (firstParty / bedrock / vertex)

### 1.3 Target State (목표 상태)

```
┌─────────────────────────────────────────────────────────┐
│                   TUI Shell (Ink 5)                      │
│  ┌──────────────────────┐  ┌─────────────────────────┐  │
│  │   PromptInput        │  │   StreamingOutput       │  │
│  │   (multiline, vim)   │  │   (markdown, diff)      │  │
│  └──────────────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│                  Agent Loop (Core)                        │
│   user input → provider.send() → tool dispatch → repeat  │
├──────────┬───────────────────────┬──────────────────────┤
│ Provider │     Tool Runtime      │   Permission Engine  │
│ Registry │  Bash, File, Grep,    │   allow / deny / ask │
│          │  Glob, Agent, MCP     │   rule matching      │
├──────────┴───────────────────────┴──────────────────────┤
│  Config (YAML)  │  Session Store  │  Context Manager    │
└─────────────────┴─────────────────┴─────────────────────┘
```

- `coreline-agent --provider local-llama "이 코드 리팩토링 해줘"` 형태로 사용
- `~/.coreline-agent/providers.yml`에 프로바이더 등록, URL/키/모델 지정
- TUI에서 `Ctrl+P`로 프로바이더 실시간 전환

### 1.4 Scope Boundary (범위)

- **In scope**:
  - Provider-agnostic LLM 어댑터 (Claude, OpenAI, Gemini, OpenAI-compatible)
  - 핵심 도구 7개 (Bash, FileRead, FileWrite, FileEdit, Glob, Grep, Agent)
  - Ink 5 기반 TUI (스트리밍 출력, 프롬프트 입력, 도구 실행 렌더링)
  - YAML 기반 프로바이더/설정 관리
  - 세션 저장/복원
  - 기본 권한 시스템 (allow / deny / ask)
- **Out of scope** (Phase 4 이후):
  - MCP 프로토콜 지원
  - 플러그인 시스템
  - 음성 입력
  - 팀 메모리 동기화
  - Chrome 확장
  - 원격 에이전트

---

## 2. Architecture Overview (아키텍처)

### 2.1 Design Diagram

```
src/
├── index.ts                    # CLI 엔트리포인트 (commander)
├── agent/
│   ├── loop.ts                 # 핵심 에이전트 루프 (async generator)
│   ├── types.ts                # Message, ToolUse, ToolResult 타입
│   └── context.ts              # ToolUseContext, AppState 관리
├── providers/
│   ├── types.ts                # LLMProvider 인터페이스
│   ├── registry.ts             # 프로바이더 등록/조회
│   ├── anthropic.ts            # Claude 어댑터
│   ├── openai.ts               # OpenAI / Codex 어댑터
│   ├── gemini.ts               # Gemini 어댑터
│   └── openai-compatible.ts    # 범용 OpenAI 호환 (Ollama, vLLM 등)
├── tools/
│   ├── types.ts                # Tool 인터페이스, buildTool()
│   ├── registry.ts             # 도구 등록/조회/디스패치
│   ├── orchestration.ts        # 병렬/직렬 도구 실행
│   ├── bash/
│   │   ├── bash-tool.ts        # Bash 도구
│   │   └── bash-security.ts    # 명령 보안 검증
│   ├── file-read/
│   │   └── file-read-tool.ts
│   ├── file-write/
│   │   └── file-write-tool.ts
│   ├── file-edit/
│   │   └── file-edit-tool.ts
│   ├── glob/
│   │   └── glob-tool.ts
│   ├── grep/
│   │   └── grep-tool.ts
│   └── agent/
│       └── agent-tool.ts       # 서브에이전트 생성
├── permissions/
│   ├── types.ts                # PermissionMode, PermissionRule, PermissionResult
│   ├── engine.ts               # 규칙 매칭 엔진
│   └── classifier.ts           # Bash 명령 분류기 (read-only / destructive)
├── tui/
│   ├── app.tsx                 # Ink 5 루트 컴포넌트
│   ├── repl.tsx                # REPL 화면 (메시지 + 입력 + 상태바)
│   ├── prompt-input.tsx        # 프롬프트 입력 컴포넌트
│   ├── streaming-output.tsx    # 스트리밍 마크다운 렌더링
│   ├── tool-result.tsx         # 도구 결과 렌더링
│   ├── status-bar.tsx          # 모델/비용/토큰 상태바
│   └── provider-switcher.tsx   # 프로바이더 전환 UI
├── config/
│   ├── schema.ts               # Zod 스키마 (providers.yml, settings.yml)
│   ├── loader.ts               # YAML 로드/저장
│   └── paths.ts                # ~/.coreline-agent/ 경로 관리
├── session/
│   ├── storage.ts              # JSONL 세션 저장/복원
│   └── history.ts              # 대화 히스토리 관리
└── utils/
    ├── token-estimator.ts      # 토큰 수 추정
    ├── shell.ts                # 셸 명령 실행 유틸
    ├── git.ts                  # Git 유틸
    └── path.ts                 # 경로 유틸
```

### 2.2 Key Design Decisions

| 결정 사항 | 선택 | 근거 |
|-----------|------|------|
| Runtime | Bun | 빠른 기동, 내장 TS, Claude Code도 Bun 지원 |
| TUI Framework | Ink 5 (React) | 컴포넌트 기반, 스트리밍 렌더링, 검증된 패턴 |
| LLM SDK | 직접 HTTP + 프로바이더별 SDK | Vercel AI SDK 대비 제어력 우위, tool_call 포맷 통제 |
| Tool Schema | Zod | 런타임 검증 + JSON Schema 자동 생성 (`zodToJsonSchema`) |
| Config Format | YAML | 사람이 읽기 쉬움, 주석 지원 |
| Agent Loop | Async Generator | 이벤트 스트리밍, Claude Code 검증 패턴 |
| 프로바이더 전환 | Registry + YAML | URL 기반 등록, 런타임 전환 |
| 권한 시스템 | Rule-based (allow/deny/ask) | Claude Code 패턴 간소화 |
| 세션 저장 | JSONL | 증분 쓰기, 대용량 대화 지원 |

### 2.3 핵심 인터페이스 설계

#### LLMProvider (프로바이더 추상화)

```typescript
// src/providers/types.ts

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
}

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface ChatChunk {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done'
  text?: string
  toolCall?: Partial<ToolCall>
  usage?: { inputTokens: number; outputTokens: number }
}

interface ChatRequest {
  messages: ChatMessage[]
  systemPrompt?: string
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

interface LLMProvider {
  name: string
  send(req: ChatRequest): AsyncIterable<ChatChunk>
  countTokens?(text: string): number
  maxContextTokens: number
  supportsToolCalling: boolean
  supportsStreaming: boolean
}
```

#### Tool (도구 추상화)

```typescript
// src/tools/types.ts

interface ToolResult<T = unknown> {
  data: T
  isError?: boolean
}

interface Tool<Input = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: ZodType<Input>

  call(input: Input, context: ToolUseContext): Promise<ToolResult<Output>>
  checkPermissions(input: Input, context: ToolUseContext): PermissionResult
  
  isReadOnly(input: Input): boolean
  isConcurrencySafe(input: Input): boolean
  
  formatResult(output: Output, toolUseId: string): string
  renderToolUse(input: Partial<Input>): React.ReactNode
  renderToolResult(output: Output): React.ReactNode
}

function buildTool<D extends ToolDef>(def: D): Tool {
  return { ...TOOL_DEFAULTS, ...def }
}
```

#### Agent Loop (에이전트 루프)

```typescript
// src/agent/loop.ts

type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolName: string; input: unknown }
  | { type: 'tool_progress'; toolName: string; output: string }
  | { type: 'tool_end'; toolName: string; result: unknown }
  | { type: 'turn_end'; reason: string; usage: Usage }
  | { type: 'error'; error: Error }

async function* agentLoop(params: {
  provider: LLMProvider
  tools: Tool[]
  messages: ChatMessage[]
  systemPrompt: string
  permissionEngine: PermissionEngine
  signal: AbortSignal
}): AsyncGenerator<AgentEvent, { reason: string }> {
  // Claude Code queryLoop() 패턴:
  // while (true) {
  //   1. provider.send(messages, tools)  → stream text + tool_calls
  //   2. yield text_delta events
  //   3. if tool_calls → execute → yield tool events → append results → continue
  //   4. if no tool_calls → return { reason: 'completed' }
  // }
}
```

### 2.4 New Files (신규 파일)

| 파일 경로 | 용도 |
|-----------|------|
| `src/index.ts` | CLI 엔트리포인트 (commander.js) |
| `src/agent/loop.ts` | 핵심 에이전트 루프 |
| `src/agent/types.ts` | 메시지·이벤트 타입 |
| `src/agent/context.ts` | ToolUseContext, AppState |
| `src/providers/types.ts` | LLMProvider 인터페이스 |
| `src/providers/registry.ts` | 프로바이더 레지스트리 |
| `src/providers/anthropic.ts` | Claude 어댑터 |
| `src/providers/openai.ts` | OpenAI/Codex 어댑터 |
| `src/providers/gemini.ts` | Gemini 어댑터 |
| `src/providers/openai-compatible.ts` | 범용 OpenAI 호환 어댑터 |
| `src/tools/types.ts` | Tool 인터페이스, buildTool() |
| `src/tools/registry.ts` | 도구 레지스트리 |
| `src/tools/orchestration.ts` | 도구 실행 오케스트레이션 |
| `src/tools/bash/bash-tool.ts` | Bash 도구 |
| `src/tools/bash/bash-security.ts` | Bash 보안 검증 |
| `src/tools/file-read/file-read-tool.ts` | 파일 읽기 도구 |
| `src/tools/file-write/file-write-tool.ts` | 파일 쓰기 도구 |
| `src/tools/file-edit/file-edit-tool.ts` | 파일 편집 도구 |
| `src/tools/glob/glob-tool.ts` | 파일 검색 도구 |
| `src/tools/grep/grep-tool.ts` | 텍스트 검색 도구 |
| `src/tools/agent/agent-tool.ts` | 서브에이전트 도구 |
| `src/permissions/types.ts` | 권한 타입 |
| `src/permissions/engine.ts` | 권한 엔진 |
| `src/permissions/classifier.ts` | 명령 분류기 |
| `src/tui/app.tsx` | Ink 루트 |
| `src/tui/repl.tsx` | REPL 화면 |
| `src/tui/prompt-input.tsx` | 입력 컴포넌트 |
| `src/tui/streaming-output.tsx` | 스트리밍 출력 |
| `src/tui/tool-result.tsx` | 도구 결과 렌더링 |
| `src/tui/status-bar.tsx` | 상태바 |
| `src/tui/provider-switcher.tsx` | 프로바이더 전환 |
| `src/config/schema.ts` | 설정 스키마 |
| `src/config/loader.ts` | YAML 로더 |
| `src/config/paths.ts` | 경로 관리 |
| `src/session/storage.ts` | 세션 저장 |
| `src/session/history.ts` | 히스토리 관리 |
| `src/utils/token-estimator.ts` | 토큰 추정 |
| `src/utils/shell.ts` | 셸 실행 |
| `src/utils/git.ts` | Git 유틸 |
| `src/utils/path.ts` | 경로 유틸 |
| `package.json` | 프로젝트 설정 |
| `tsconfig.json` | TypeScript 설정 |
| `tests/` | 테스트 디렉토리 |

---

## 3. Phase Dependencies (페이즈 의존성)

```
Phase 0 (기반 설정)
    │
    ├── Phase 1 (프로바이더 어댑터) ──┐
    │                                 │
    ├── Phase 2 (도구 시스템) ────────┤  ← 1, 2 병렬 가능
    │                                 │
    └── Phase 3 (권한 시스템) ────────┘
                                      │
                                      ▼
                               Phase 4 (에이전트 루프)
                                      │
                                      ▼
                               Phase 5 (TUI Shell)
                                      │
                                      ▼
                               Phase 6 (세션 & 설정)
                                      │
                                      ▼
                               Phase 7 (통합 & 마감)
```

---

## 4. Implementation Phases (구현 페이즈)

### Phase 0: Foundation Setup (기반 설정)
> 프로젝트 스캐폴딩 + 빌드 체인 + 핵심 타입 정의
> Dependencies: 없음

#### Tasks
- (historical task) `package.json` 생성: name `coreline-agent`, bin `coreline-agent`, type `module`, Bun runtime
- (historical task) `tsconfig.json` 생성: target `ES2022`, jsx `react-jsx`, jsxImportSource `react`, strict mode
- (historical task) 의존성 설치: `ink@5`, `react@18`, `zod`, `commander`, `yaml`, `chalk`, `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`
- (historical task) `src/agent/types.ts` 작성: `ChatMessage`, `ContentBlock`, `ToolCall`, `ToolResult`, `AgentEvent`, `Usage` 타입 정의
- (historical task) `src/providers/types.ts` 작성: `LLMProvider`, `ChatRequest`, `ChatChunk`, `ToolDefinition` 인터페이스 정의
- (historical task) `src/tools/types.ts` 작성: `Tool`, `ToolDef`, `ToolUseContext`, `buildTool()` 팩토리 함수
- (historical task) `src/index.ts` 작성: commander 기반 CLI 엔트리포인트 (--provider, --model, prompt 인자)

#### Success Criteria
- `bun run src/index.ts --help` 실행 시 도움말 출력
- 타입 파일 간 순환 의존 없음
- `bun build --target=bun src/index.ts` 에러 0건

#### Test Cases
- (historical task) TC-0.1: `bun run src/index.ts --version` → 버전 문자열 출력
- (historical task) TC-0.2: `bun run src/index.ts --help` → --provider, --model 옵션 표시
- (historical task) TC-0.3: 타입 파일 import 검증 → `bun typecheck` 통과
- (historical task) TC-0.E1: 알 수 없는 옵션 `--foo` → 에러 메시지 출력

#### Testing Instructions
```bash
cd coreline-agent
bun install
bun run src/index.ts --help
bun run src/index.ts --version
```

---

### Phase 1: Provider Adapters (프로바이더 어댑터)
> LLM 프로바이더별 어댑터 구현 + 레지스트리
> Dependencies: Phase 0

#### Tasks
- (historical task) `src/providers/openai-compatible.ts`: OpenAI 호환 어댑터 구현 — `send()` → `fetch()` 기반 SSE 스트리밍, tool_call 파싱. Ollama/LM Studio/vLLM 공용
- (historical task) `src/providers/anthropic.ts`: Anthropic SDK 래핑 — `messages.stream()` → `ChatChunk` 변환. `tool_use` content block → `ToolCall` 매핑
- (historical task) `src/providers/openai.ts`: OpenAI SDK 래핑 — `chat.completions.create({ stream: true })` → `ChatChunk` 변환. `tool_calls` delta 스트리밍 처리
- (historical task) `src/providers/gemini.ts`: Google Generative AI SDK 래핑 — `generateContentStream()` → `ChatChunk` 변환. `functionCall` part → `ToolCall` 매핑
- (historical task) `src/providers/registry.ts`: `ProviderRegistry` 클래스 — YAML config에서 프로바이더 목록 로드, `getProvider(name)`, `listProviders()`, `setDefault(name)`
- (historical task) `src/config/schema.ts`: 프로바이더 설정 Zod 스키마 — `ProviderConfig { name, type, baseUrl?, apiKey?, model, maxContextTokens? }`

#### Success Criteria
- 각 어댑터가 동일한 `LLMProvider` 인터페이스 구현
- OpenAI-compatible 어댑터로 Ollama 로컬 모델에 "hello" 전송 → 스트리밍 응답 수신
- Anthropic 어댑터로 Claude에 "hello" 전송 → 스트리밍 응답 수신
- tool_call이 포함된 응답 파싱 성공

#### Test Cases
- (historical task) TC-1.1: OpenAI-compatible 어댑터 — `baseUrl: http://localhost:11434/v1` + Ollama 모델 → 텍스트 스트리밍 수신
- (historical task) TC-1.2: Anthropic 어댑터 — Claude sonnet → "1+1=" 질문 → 텍스트 응답 포함
- (historical task) TC-1.3: OpenAI 어댑터 — GPT-4o → tool definition 전달 + tool_call 응답 파싱
- (historical task) TC-1.4: Gemini 어댑터 — Gemini Pro → 텍스트 스트리밍 수신
- (historical task) TC-1.5: Registry — YAML에서 3개 프로바이더 로드 → `listProviders()` 길이 3
- (historical task) TC-1.6: Registry — `getProvider('nonexistent')` → 에러 throw
- (historical task) TC-1.E1: 잘못된 API 키 → 인증 에러 메시지 반환 (크래시 아님)
- (historical task) TC-1.E2: 연결 불가 URL → 타임아웃 에러 (크래시 아님)
- (historical task) TC-1.E3: tool_call 없는 응답 → `toolCall` 필드 undefined

#### Testing Instructions
```bash
# Ollama 로컬 테스트 (사전: ollama serve + ollama pull llama3.2)
bun test tests/providers/openai-compatible.test.ts

# Claude API 테스트 (사전: ANTHROPIC_API_KEY 설정)
bun test tests/providers/anthropic.test.ts

# 전체 프로바이더 테스트
bun test tests/providers/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → SSE 파싱 / SDK 버전 / 네트워크 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 2: Tool System (도구 시스템)
> 핵심 도구 7개 구현 + 도구 레지스트리 + 실행 오케스트레이션
> Dependencies: Phase 0
> **Phase 1과 병렬 진행 가능**

#### Tasks
- (historical task) `src/tools/registry.ts`: `ToolRegistry` — `register(tool)`, `getByName(name)`, `getAll()`, `getToolDefinitions(): ToolDefinition[]` (LLM에 전달할 JSON Schema 배열 생성)
- (historical task) `src/tools/glob/glob-tool.ts`: `buildTool()` 패턴 — `fast-glob` 사용, pattern + path 입력, 파일 목록 반환. `isReadOnly: true`, `isConcurrencySafe: true`
- (historical task) `src/tools/grep/grep-tool.ts`: `buildTool()` 패턴 — `child_process`로 `rg` 실행, pattern + path + glob 필터. output_mode: content / files_with_matches / count
- (historical task) `src/tools/file-read/file-read-tool.ts`: 파일 읽기 — `file_path` + `offset?` + `limit?`. 이미지 감지 시 base64 반환. 최대 2000줄 기본 제한
- (historical task) `src/tools/file-write/file-write-tool.ts`: 파일 생성/덮어쓰기 — `file_path` + `content`. 디렉토리 자동 생성. `isReadOnly: false`
- (historical task) `src/tools/file-edit/file-edit-tool.ts`: 문자열 치환 편집 — `file_path` + `old_string` + `new_string` + `replace_all?`. 유니크 매칭 검증. diff 생성
- (historical task) `src/tools/bash/bash-tool.ts`: 셸 명령 실행 — `command` + `timeout?`. `child_process.spawn`으로 실행, stdout+stderr 캡처. 타임아웃 기본 120초
- (historical task) `src/tools/orchestration.ts`: 도구 실행 오케스트레이터 — `isConcurrencySafe` 기준 병렬/직렬 분기. 최대 동시 실행 10개. async generator로 이벤트 yield

#### Success Criteria
- 7개 도구 모두 `Tool` 인터페이스 구현
- `registry.getToolDefinitions()`로 LLM 전달용 JSON Schema 생성
- Glob → 파일 검색, Grep → 텍스트 검색, FileRead → 파일 읽기 정상 동작
- FileEdit → 유니크하지 않은 문자열 시 에러 반환
- Bash → `echo hello` 실행 → `hello\n` 반환
- 읽기 전용 도구 병렬 실행, 쓰기 도구 직렬 실행

#### Test Cases
- (historical task) TC-2.1: GlobTool — `pattern: "*.ts", path: "src/"` → TypeScript 파일 목록 반환
- (historical task) TC-2.2: GrepTool — `pattern: "function", path: "src/"` → 매칭 파일 목록 반환
- (historical task) TC-2.3: FileReadTool — 존재하는 파일 → 내용 반환 (줄번호 포함)
- (historical task) TC-2.4: FileReadTool — `offset: 10, limit: 5` → 10~14번째 줄만 반환
- (historical task) TC-2.5: FileWriteTool — 새 파일 생성 → 파일 존재 확인
- (historical task) TC-2.6: FileEditTool — `old_string` 유니크 매칭 → 치환 성공
- (historical task) TC-2.7: BashTool — `echo hello` → stdout `hello`
- (historical task) TC-2.8: Orchestration — 읽기 도구 3개 → 병렬 실행 (소요시간 ≈ 단일 실행)
- (historical task) TC-2.E1: FileReadTool — 존재하지 않는 파일 → `isError: true`
- (historical task) TC-2.E2: FileEditTool — `old_string` 2개 이상 매칭 → 에러 "not unique"
- (historical task) TC-2.E3: BashTool — `sleep 300` + timeout 1초 → 타임아웃 에러
- (historical task) TC-2.E4: GrepTool — `rg` 미설치 환경 → 안내 메시지

#### Testing Instructions
```bash
bun test tests/tools/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 3: Permission Engine (권한 시스템)
> 도구 실행 전 권한 검증 레이어
> Dependencies: Phase 0
> **Phase 1, 2와 병렬 진행 가능**

#### Tasks
- (historical task) `src/permissions/types.ts`: `PermissionMode` (default / acceptAll / denyAll), `PermissionRule { behavior, toolName, pattern? }`, `PermissionResult { behavior, reason }`
- (historical task) `src/permissions/engine.ts`: `PermissionEngine` 클래스 — 규칙 로드, `check(tool, input) → PermissionResult`. 우선순위: deny > ask > allow
- (historical task) `src/permissions/classifier.ts`: Bash 명령 분류기 — 읽기 전용 명령 (`ls`, `cat`, `git log` 등) 자동 허용. 파괴적 명령 (`rm`, `git push` 등) 사용자 확인 요청
- (historical task) 규칙 설정 파일 `~/.coreline-agent/permissions.yml` 스키마 정의

#### Success Criteria
- `engine.check(bashTool, { command: "ls" })` → `{ behavior: 'allow' }`
- `engine.check(bashTool, { command: "rm -rf /" })` → `{ behavior: 'ask' }`
- `engine.check(fileWriteTool, { file_path: "/etc/passwd" })` → `{ behavior: 'deny' }`
- deny 규칙이 항상 allow보다 우선

#### Test Cases
- (historical task) TC-3.1: 읽기 전용 명령 (`ls`, `cat`, `head`) → allow
- (historical task) TC-3.2: 파괴적 명령 (`rm -rf`, `git push --force`) → ask
- (historical task) TC-3.3: 시스템 경로 쓰기 (`/etc/`, `/usr/`) → deny
- (historical task) TC-3.4: 커스텀 규칙 `{ behavior: allow, toolName: Bash, pattern: "npm test" }` → allow
- (historical task) TC-3.5: 규칙 충돌 시 deny > ask > allow 우선순위
- (historical task) TC-3.E1: 알 수 없는 도구 이름 → deny (fail-safe)

#### Testing Instructions
```bash
bun test tests/permissions/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 4: Agent Loop (에이전트 루프)
> 핵심 에이전트 루프 구현 — 프로바이더 + 도구 + 권한 통합
> Dependencies: Phase 1, Phase 2, Phase 3

#### Tasks
- (historical task) `src/agent/context.ts`: `ToolUseContext` 구현 — `tools`, `permissionEngine`, `abortController`, `cwd`, `getAppState()`, `setAppState()` 포함
- (historical task) `src/agent/loop.ts`: `agentLoop()` async generator 구현:
  - (1) 메시지 + 시스템 프롬프트 + 도구 정의를 provider.send()에 전달
  - (2) 스트리밍 텍스트를 `text_delta` 이벤트로 yield
  - (3) tool_call 수집 → 도구 실행 → `tool_start` / `tool_end` 이벤트 yield
  - (4) 도구 결과를 메시지에 추가 → 루프 반복
  - (5) tool_call 없으면 `turn_end` 반환
- (historical task) 도구 실행 시 `permissionEngine.check()` 호출 → deny면 에러 메시지 반환, ask면 이벤트 yield
- (historical task) `maxTurns` 제한 (기본 50) — 무한 루프 방지
- (historical task) AbortController 연동 — `Ctrl+C` 시 현재 API 호출/도구 실행 중단
- (historical task) 에러 복구 — API 에러 시 재시도 (최대 3회), 도구 에러 시 에러 메시지를 LLM에 전달

#### Success Criteria
- "1+1은?" → 텍스트 응답 (도구 호출 없음) → `turn_end`
- "현재 디렉토리 파일 목록 보여줘" → GlobTool 호출 → 결과 반환 → 텍스트 응답 → `turn_end`
- 다단계: "src/index.ts 읽고 버그 있으면 수정해줘" → FileRead → FileEdit → 완료
- Ctrl+C → 즉시 중단, 비정상 종료 없음

#### Test Cases
- (historical task) TC-4.1: 단순 질문 (도구 호출 없음) → text_delta 이벤트 수신 → turn_end
- (historical task) TC-4.2: 단일 도구 호출 → tool_start → tool_end → text_delta → turn_end
- (historical task) TC-4.3: 다중 도구 호출 (연쇄) → 2회 이상 루프 반복 후 turn_end
- (historical task) TC-4.4: 권한 deny 도구 → 에러 메시지가 LLM에 전달 → LLM이 대안 제시
- (historical task) TC-4.5: maxTurns 초과 → 강제 종료 + 경고 메시지
- (historical task) TC-4.6: AbortController signal → 즉시 종료
- (historical task) TC-4.E1: API 네트워크 에러 → 3회 재시도 후 에러 이벤트
- (historical task) TC-4.E2: 도구 실행 에러 → 에러를 LLM에 전달 (에이전트 크래시 아님)
- (historical task) TC-4.E3: 프로바이더가 tool_call 미지원 → 텍스트 응답만 처리

#### Testing Instructions
```bash
# 단위 테스트 (mock provider)
bun test tests/agent/loop.test.ts

# 통합 테스트 (실제 Ollama)
PROVIDER=local bun test tests/agent/integration.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 5: TUI Shell (터미널 UI)
> Ink 5 기반 대화형 TUI — 스트리밍 출력, 프롬프트 입력, 상태바
> Dependencies: Phase 4

#### Tasks
- (historical task) `src/tui/app.tsx`: Ink 5 루트 컴포넌트 — `<App provider={} tools={} config={} />`
- (historical task) `src/tui/repl.tsx`: REPL 컴포넌트:
  - 상단: 메시지 히스토리 (스크롤 가능)
  - 중단: 스트리밍 출력 영역 (마크다운 렌더링)
  - 하단: 프롬프트 입력 + 상태바
  - agentLoop() 이벤트를 구독하여 실시간 업데이트
- (historical task) `src/tui/prompt-input.tsx`: 멀티라인 입력 — Enter로 제출, Shift+Enter로 줄바꿈, 히스토리 (위/아래 화살표)
- (historical task) `src/tui/streaming-output.tsx`: 스트리밍 텍스트 렌더링 — `text_delta` 이벤트를 받아 점진적 표시. 마크다운 코드 블록 하이라이팅
- (historical task) `src/tui/tool-result.tsx`: 도구 실행 결과 렌더링 — 도구명 + 입력 요약 + 결과 (접기/펼치기)
- (historical task) `src/tui/status-bar.tsx`: 상태바 — 현재 모델명, 프로바이더, 토큰 사용량, 권한 모드 표시
- (historical task) `src/tui/provider-switcher.tsx`: `Ctrl+P` 단축키 → 프로바이더 목록 표시 → 선택으로 실시간 전환

#### Success Criteria
- `coreline-agent` 실행 → TUI 렌더링, 프롬프트 입력 대기
- 질문 입력 → 스트리밍 텍스트가 한 글자씩 표시
- 도구 호출 시 → 도구명과 실행 상태 표시
- `Ctrl+P` → 프로바이더 목록, 선택 시 전환
- `Ctrl+C` → 현재 작업 중단 / 두 번 → 종료

#### Test Cases
- (historical task) TC-5.1: TUI 기동 → 프롬프트 입력 커서 표시
- (historical task) TC-5.2: 텍스트 입력 + Enter → agentLoop 시작 → 스트리밍 출력
- (historical task) TC-5.3: 도구 호출 → `🔧 BashTool: echo hello` 스타일 표시
- (historical task) TC-5.4: 도구 결과 → 접힌 상태로 결과 요약, 클릭/키로 펼치기
- (historical task) TC-5.5: 상태바 → 모델명 + 토큰 수 실시간 갱신
- (historical task) TC-5.6: Ctrl+P → 프로바이더 목록 → 선택 → 상태바에 반영
- (historical task) TC-5.7: 멀티라인 입력 → Shift+Enter로 줄바꿈, Enter로 제출
- (historical task) TC-5.E1: 터미널 크기 변경 → 레이아웃 재조정 (크래시 없음)

#### Testing Instructions
```bash
# TUI 수동 테스트
bun run src/index.ts

# 컴포넌트 단위 테스트 (ink-testing-library)
bun test tests/tui/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 6: Session & Config (세션 + 설정)
> 대화 세션 저장/복원 + YAML 기반 설정 관리
> Dependencies: Phase 5

#### Tasks
- (historical task) `src/config/paths.ts`: `~/.coreline-agent/` 디렉토리 관리 — `config.yml`, `providers.yml`, `permissions.yml`, `sessions/`
- (historical task) `src/config/loader.ts`: YAML 로드/저장 유틸 — Zod 검증 + 기본값 머지 + 원자적 쓰기
- (historical task) `src/config/schema.ts` 확장: 전체 설정 스키마 — providers, permissions, defaultProvider, theme, maxTurns
- (historical task) `src/session/storage.ts`: JSONL 기반 세션 저장 — 메시지 단위 append, 세션 ID로 파일 분리
- (historical task) `src/session/history.ts`: 세션 목록 조회, 세션 복원 (`--resume` 플래그), 세션 삭제
- (historical task) CLI에 `--resume [sessionId]` 옵션 추가
- (historical task) 시스템 프롬프트 템플릿 — `~/.coreline-agent/system-prompt.md` 커스터마이징 지원

#### Success Criteria
- 대화 후 `~/.coreline-agent/sessions/` 에 JSONL 파일 생성
- `coreline-agent --resume` → 마지막 세션 복원, 이전 대화 이어감
- `providers.yml` 수정 → 재시작 없이 반영 (TUI에서 Ctrl+P 시)
- 잘못된 YAML → Zod 검증 에러 메시지 출력 (크래시 아님)

#### Test Cases
- (historical task) TC-6.1: 대화 3턴 → JSONL에 메시지 6개 (user 3 + assistant 3) 저장
- (historical task) TC-6.2: `--resume` → 이전 세션 메시지 로드 → 컨텍스트에 포함
- (historical task) TC-6.3: `providers.yml`에 새 프로바이더 추가 → Ctrl+P 목록에 반영
- (historical task) TC-6.4: `permissions.yml` 규칙 변경 → 즉시 적용
- (historical task) TC-6.5: `system-prompt.md` 존재 시 → 시스템 프롬프트에 내용 추가
- (historical task) TC-6.E1: JSONL 파싱 에러 (깨진 파일) → 에러 로그 + 새 세션 시작
- (historical task) TC-6.E2: 잘못된 YAML 포맷 → 검증 에러 메시지 + 기본값 사용

#### Testing Instructions
```bash
bun test tests/config/
bun test tests/session/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 7: Integration & Polish (통합 마감)
> 전체 통합 테스트 + CLI 완성도 + 에러 핸들링 강화
> Dependencies: Phase 6

#### Tasks
- (historical task) CLI 비대화형 모드: `coreline-agent -p "파일 목록 보여줘"` → 결과 출력 후 종료 (파이프 지원)
- (historical task) 시스템 프롬프트 조립 — 현재 디렉토리, Git 상태, OS 정보, 사용 가능 도구 목록 자동 주입
- (historical task) 에러 핸들링 강화 — unhandled rejection, SIGTERM, 메모리 초과 대응
- (historical task) `--verbose` 플래그 — API 요청/응답 로깅, 도구 실행 상세 로그
- (historical task) `--json` 플래그 — AgentEvent를 NDJSON으로 stdout 출력 (다른 프로그램과 파이프)
- (historical task) 도움말 및 온보딩 — 첫 실행 시 프로바이더 설정 가이드

#### Success Criteria
- `echo "hello" | coreline-agent -p "이 텍스트 분석해줘"` → 파이프 입력 처리
- `coreline-agent --json -p "1+1="` → NDJSON 이벤트 스트림 출력
- 프로바이더 미설정 상태 → 온보딩 가이드 표시
- 전체 E2E: "src/ 디렉토리 구조 분석하고 README.md 생성해줘" → 다단계 도구 호출 → 파일 생성

#### Test Cases
- (historical task) TC-7.1: E2E — Claude provider + "현재 디렉토리 파일 목록" → Glob 호출 → 응답
- (historical task) TC-7.2: E2E — Ollama provider + "hello" → 텍스트 응답
- (historical task) TC-7.3: 비대화형 — `-p "1+1"` → 결과 출력 → exit code 0
- (historical task) TC-7.4: JSON 모드 — `--json` → 유효한 NDJSON 출력
- (historical task) TC-7.5: 파이프 입력 — `echo "code" | coreline-agent -p "리뷰해줘"` → stdin 내용 컨텍스트에 포함
- (historical task) TC-7.6: 프로바이더 미설정 → 온보딩 가이드 → 설정 완료 → 대화 시작
- (historical task) TC-7.E1: SIGTERM → graceful shutdown (세션 저장 후 종료)

#### Testing Instructions
```bash
# 전체 통합 테스트
bun test tests/integration/

# E2E 수동 테스트
bun run src/index.ts
bun run src/index.ts -p "hello world"
echo "test" | bun run src/index.ts --json -p "analyze this"
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

## 5. Integration & Verification (통합 검증)

### 5.1 Integration Test Plan

- (historical task) E2E-1: 프로바이더 전환 — Claude로 대화 시작 → Ctrl+P로 Ollama 전환 → 대화 이어감
- (historical task) E2E-2: 다단계 코딩 — "src/hello.ts 파일 만들고, 함수 작성하고, 테스트 실행" → FileWrite → FileEdit → Bash
- (historical task) E2E-3: 권한 통합 — `rm -rf /` 시도 → ask 프롬프트 → deny → LLM에 거부 사유 전달
- (historical task) E2E-4: 세션 복원 — 5턴 대화 → 종료 → `--resume` → 6번째 턴부터 이어감
- (historical task) E2E-5: 대용량 출력 — 1000줄 파일 읽기 → 결과 트렁케이션 + 전체 내용은 LLM에 전달

### 5.2 Manual Verification Steps

1. `bun run src/index.ts` → TUI 기동 확인
2. "현재 디렉토리 파일 보여줘" → Glob 도구 호출 → 결과 표시
3. `Ctrl+P` → 프로바이더 목록 → 다른 모델 선택
4. "src/index.ts 읽어줘" → FileRead → 코드 표시
5. `Ctrl+C` → 대화 중단 → 프롬프트로 복귀
6. `Ctrl+C` 두 번 → 종료 → 세션 저장 확인

### 5.3 Rollback Strategy

- 각 Phase는 독립 Git 브랜치에서 작업
- Phase 실패 시 해당 브랜치만 revert
- 데이터 마이그레이션 없음 (Phase 6 세션 포맷은 JSONL이라 하위 호환 불필요)

---

## 6. Edge Cases & Risks (엣지 케이스 및 위험)

| 위험 요소 | 영향도 | 완화 방안 |
|-----------|--------|-----------|
| LLM이 tool_call JSON을 잘못 생성 | 높음 | Zod `safeParse` + 에러를 LLM에 피드백 ("JSON 파싱 실패, 다시 시도") |
| 로컬 LLM의 tool calling 품질 낮음 | 중간 | ReAct 프롬프트 폴백 (텍스트에서 도구 호출 파싱) |
| Ink 5 + Bun 호환성 문제 | 중간 | Node.js 폴백 지원 (package.json engines) |
| 대용량 파일 읽기 시 컨텍스트 초과 | 높음 | `maxResultSizeChars` 제한 + 트렁케이션 |
| 동시 도구 실행 시 파일 충돌 | 중간 | 쓰기 도구는 항상 직렬 실행 |
| API 키 유출 (설정 파일) | 높음 | 파일 권한 600, `.gitignore` 자동 생성, 환경변수 우선 |
| SSE 스트리밍 파싱 에러 (프로바이더별 차이) | 중간 | 프로바이더별 테스트 스위트, 에러 시 폴백 |
| 무한 도구 호출 루프 | 높음 | `maxTurns` 제한 (기본 50) |

---

## 7. Execution Rules (실행 규칙)

1. **독립 모듈**: 각 Phase는 독립적으로 구현하고 테스트한다
2. **완료 조건**: 모든 태스크 체크박스 체크 + 모든 테스트 통과
3. **테스트 실패 워크플로우**: 에러 분석 → 근본 원인 수정 → 재테스트 → 통과 후에만 다음 Phase 진행
4. **Phase 완료 기록**: 체크박스를 체크하여 이 문서에 진행 상황 기록
5. **병렬 실행**: Phase 1 + Phase 2 + Phase 3은 동시 진행 가능
6. **커밋 전략**: Phase당 1~3개 커밋, 의미 단위로 분리

---

## 8. 프로바이더 설정 예시 (providers.yml)

```yaml
# ~/.coreline-agent/providers.yml

default: claude

providers:
  claude:
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}      # 환경변수 참조
    model: claude-sonnet-4-20250514
    maxContextTokens: 200000

  gpt4:
    type: openai
    apiKey: ${OPENAI_API_KEY}
    model: gpt-4o
    maxContextTokens: 128000

  gemini:
    type: gemini
    apiKey: ${GOOGLE_API_KEY}
    model: gemini-2.5-pro
    maxContextTokens: 1000000

  local-llama:
    type: openai-compatible
    baseUrl: http://localhost:11434/v1
    model: llama3.1:70b
    maxContextTokens: 128000

  company-llm:
    type: openai-compatible
    baseUrl: https://llm.internal.company.com/v1
    apiKey: ${COMPANY_LLM_KEY}
    model: custom-codegen-v2
    maxContextTokens: 32000

  lm-studio:
    type: openai-compatible
    baseUrl: http://localhost:1234/v1
    model: deepseek-coder-v2
    maxContextTokens: 64000
```

---

## 9. 기술 의존성 정리

| 패키지 | 용도 | 버전 |
|--------|------|------|
| `ink` | TUI 프레임워크 | ^5.0.0 |
| `react` | UI 렌더링 | ^18.3.0 |
| `zod` | 스키마 검증 | ^3.23.0 |
| `commander` | CLI 파서 | ^12.0.0 |
| `yaml` | YAML 파싱 | ^2.4.0 |
| `chalk` | 터미널 색상 | ^5.3.0 |
| `@anthropic-ai/sdk` | Claude API | ^0.39.0 |
| `openai` | OpenAI API | ^4.73.0 |
| `@google/generative-ai` | Gemini API | ^0.21.0 |
| `fast-glob` | 파일 검색 | ^3.3.0 |
| `zod-to-json-schema` | Tool JSON Schema 생성 | ^3.23.0 |
| `ink-testing-library` | TUI 테스트 | ^4.0.0 |

---

## 10. MVP 규모 추정

| 모듈 | 예상 LOC | 파일 수 |
|------|----------|---------|
| agent/ | 1,200 | 3 |
| providers/ | 2,400 | 6 |
| tools/ | 3,500 | 12 |
| permissions/ | 800 | 3 |
| tui/ | 2,500 | 7 |
| config/ | 600 | 3 |
| session/ | 500 | 2 |
| utils/ | 400 | 4 |
| tests/ | 2,000 | 15 |
| **합계** | **~13,900** | **~55** |
