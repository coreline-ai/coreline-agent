# Implementation Plan: Intelligence Accumulation

## 문서 동기화 상태 (2026-04-19)

- 상태: **ARCHIVED / SUPERSEDED**
- 현재 기준: 초기 AGENT.md/Memory 축적 설계 문서입니다. 현재 memory/AGENT.md 동작 기준은 docs/memory-system.md와 관련 테스트입니다.
- Source of truth: `docs/memory-system.md, tests/memory-*.test.ts, dev-plan/implement_20260415_205850.md`
- 아래 체크리스트는 **활성 TODO가 아니라 과거 구현 계획 기록**입니다.
- 혼동 방지를 위해 미완료 체크박스 표기는 `(historical task)`로 변환했습니다.
- 현재 미구현/후속 항목은 `docs/implementation-status.md`와 최신 `dev-plan/implement_*.md`를 기준으로 판단합니다.

---


> 프로젝트별 AGENT.md 자동 로드 + auto-memory 시스템 + Memory 도구로 에이전트가 대화를 거치며 지능을 축적하도록 구현
> Generated: 2026-04-13
> Project: coreline-agent

---

## 1. Context (배경)

### 1.1 Why (왜 필요한가)

- **원래 목적 (멀티 프로바이더 TUI)**: 완료. 137개 파일, 143개 테스트 통과, GitHub push 완료
- **추가 필요성**: 현재는 "메시지 기록 저장"만 가능. Claude Code처럼 대화를 거치며 누적되는 지식(사용자 프로필, 선호도, 프로젝트 컨벤션, 피드백 규칙) 없음
- **사용자 가치**:
  - 같은 설명을 매번 반복하지 않음 ("난 Bun 써, TypeScript strict 모드야" 등)
  - 프로젝트별 규칙이 자동 로드됨 (예: "절대 `/etc/` 수정 금지")
  - 교훈이 누적됨 (한 번 실수했던 패턴을 반복하지 않음)

### 1.2 Current State (현재 상태)

| 영역 | 현재 상태 |
|------|-----------|
| 세션 저장 | JSONL에 원본 메시지 저장 (복원은 가능) |
| 시스템 프롬프트 | `~/.coreline-agent/system-prompt.md` 전역 1개만 지원 |
| 프로젝트 컨텍스트 | Git branch/status만 주입 |
| 지식 축적 | ❌ 없음 |
| 에이전트의 메모리 쓰기 | ❌ 불가능 |

### 1.3 Target State (목표 상태)

```
대화 시작
  ├─ cwd 스캔 → AGENT.md / CLAUDE.md 발견 시 시스템 프롬프트 주입
  ├─ 프로젝트 ID (cwd hash) → ~/.coreline-agent/projects/{hash}/memory/MEMORY.md 자동 로드
  └─ 대화 중 에이전트가 MemoryWrite 도구로 중요 사실 기록
         ↓
대화 진행
  └─ 다음 대화 시작 시 새로운 지식이 자동 로드됨
```

**예시 시나리오:**
```
[Day 1]
User: "난 Bun 런타임 쓰고 테스트는 bun test로 돌려"
Agent: (MemoryWrite로 user_profile.md에 기록)

[Day 2 — 새 대화]
User: "테스트 실행해줘"
Agent: (자동 로드된 메모리에서 "bun test" 확인) → `bun test` 실행
```

### 1.4 Scope Boundary (범위)

- **In scope**:
  - AGENT.md / CLAUDE.md 자동 감지·로드 (cwd + 상위 디렉토리)
  - 프로젝트별 격리된 메모리 공간 (cwd SHA256 해시)
  - MEMORY.md 인덱스 + 4종 메모리 파일 (user / feedback / project / reference)
  - MemoryRead, MemoryWrite 도구
  - 대화 시작 시 자동 로드 (system prompt 주입)
  - Memory 파일 포맷 검증 (frontmatter + body)
- **Out of scope**:
  - 대화 종료 시 자동 요약 (향후 Phase)
  - 팀 메모리 동기화 (Git 기반, 향후 Phase)
  - 벡터 검색 / RAG
  - 메모리 충돌 자동 병합

---

## 2. Architecture Overview (아키텍처)

### 2.1 Design Diagram

```
~/.coreline-agent/
├── config.yml
├── providers.yml
├── permissions.yml
├── system-prompt.md                    # 전역 프롬프트 (기존)
├── sessions/                           # (기존)
└── projects/                           # ★ 신규
    └── {sha256(cwd)[:16]}/             # 프로젝트별 격리
        ├── metadata.json               # cwd 원본, 첫 접근 시각
        └── memory/
            ├── MEMORY.md               # 인덱스 (매 대화 자동 로드)
            ├── user_profile.md         # user 타입
            ├── feedback_{topic}.md     # feedback 타입 (규칙/교훈)
            ├── project_{topic}.md      # project 타입 (배경/결정)
            └── reference_{topic}.md    # reference 타입 (외부 포인터)
```

**프로젝트 루트의 AGENT.md (사용자가 직접 작성):**
```
<project_root>/AGENT.md        # 또는 CLAUDE.md
```

### 2.2 Key Design Decisions

| 결정 사항 | 선택 | 근거 |
|-----------|------|------|
| 메모리 위치 | `~/.coreline-agent/projects/{hash}/` | 프로젝트별 격리, cwd 이동해도 유지 |
| 프로젝트 ID | `SHA256(cwd).slice(0, 16)` | 충돌 확률 극소, 결정적 |
| 메모리 포맷 | Markdown + YAML frontmatter | 사람 편집 가능, 구조화 |
| AGENT.md 탐색 | cwd → 상위로 올라가며 `.git` 만날 때까지 | git repo root까지 |
| 자동 로드 대상 | MEMORY.md 본문 전체 (상한: 10KB) | Claude Code 패턴 |
| MemoryWrite 권한 | ask (기본) / allow (acceptAll) | 메모리 오염 방지 |
| 동시 쓰기 | 없다고 가정 (단일 프로세스) | 복잡도 감소 |

### 2.3 Data Flow

```
CLI start
  ↓
ProjectMemory.load(cwd)
  ├─ getProjectId(cwd) → hash
  ├─ ensureProjectDir(hash)
  ├─ loadAgentMd(cwd) → walk up dirs
  ├─ loadMemoryIndex(hash) → read MEMORY.md
  └─ combine → system prompt injection
  ↓
AgentLoop running
  ↓ (agent calls MemoryWrite)
  ├─ validate type + name
  ├─ write file
  └─ update MEMORY.md index
  ↓
Next session → loads new memory
```

### 2.4 New Files (신규 파일)

| 파일 경로 | 용도 |
|-----------|------|
| `src/memory/types.ts` | `MemoryType`, `MemoryEntry`, `ProjectMemory` 인터페이스 |
| `src/memory/project-id.ts` | `getProjectId(cwd)`, cwd→hash 변환 |
| `src/memory/project-memory.ts` | `ProjectMemory` 클래스 — 로드/저장/인덱스 관리 |
| `src/memory/agent-md-loader.ts` | cwd→상위 디렉토리 traversal, AGENT.md/CLAUDE.md 탐색 |
| `src/memory/memory-parser.ts` | frontmatter + body 파싱/직렬화 |
| `src/tools/memory-read/memory-read-tool.ts` | `MemoryRead` 도구 |
| `src/tools/memory-write/memory-write-tool.ts` | `MemoryWrite` 도구 |
| `tests/memory-basic.test.ts` | 프로젝트 ID, 경로 테스트 |
| `tests/memory-parser.test.ts` | frontmatter 파서 테스트 |
| `tests/memory-integration.test.ts` | E2E 메모리 로드→쓰기→재로드 |

### 2.5 Modified Files (수정 파일)

| 파일 경로 | 변경 내용 |
|-----------|-----------|
| `src/config/paths.ts` | `projectsDir` 경로 추가, `ensureProjectMemoryDir(hash)` 함수 추가 |
| `src/agent/system-prompt.ts` | `buildSystemPrompt()`에 AGENT.md + MEMORY.md 섹션 주입 |
| `src/index.ts` | `ALL_TOOLS`에 MemoryRead, MemoryWrite 추가. ProjectMemory 초기화 |
| `src/permissions/classifier.ts` | MemoryWrite 기본 동작은 allow (신뢰된 자기 쓰기) — 옵션 |

---

## 3. Phase Dependencies (페이즈 의존성)

```
Phase I0 (기반: 타입 + paths 확장)
    │
    ├── Phase I1 (프로젝트 ID + 디렉토리) ───┐
    │                                        │ ← 병렬 가능
    ├── Phase I2 (AGENT.md 로더) ────────────┤
    │                                        │
    └── Phase I3 (메모리 파서) ──────────────┘
                                             │
                                             ▼
                                    Phase I4 (ProjectMemory 통합)
                                             │
                                             ▼
                                    Phase I5 (MemoryRead/Write 도구)
                                             │
                                             ▼
                                    Phase I6 (시스템 프롬프트 주입 + CLI 연동)
                                             │
                                             ▼
                                    Phase I7 (E2E + 문서)
```

---

## 4. Implementation Phases (구현 페이즈)

### Phase I0: Foundation — Types & Path Extension
> 메모리 시스템의 타입 정의 + 설정 경로 확장
> Dependencies: 없음

#### Tasks
- (historical task) `src/memory/types.ts` 작성:
  - `MemoryType` = `"user" | "feedback" | "project" | "reference"`
  - `MemoryEntry { name: string; description: string; type: MemoryType; body: string; filePath: string }`
  - `MemoryIndexEntry { name: string; description: string; file: string }`
  - `AgentMdFile { path: string; content: string }`
- (historical task) `src/config/paths.ts` 확장:
  - `projectsDir = join(CONFIG_ROOT, "projects")`
  - `getProjectDir(hash: string): string`
  - `getProjectMemoryDir(hash: string): string`
  - `ensureProjectMemoryDir(hash: string): void` — mkdir -p
- (historical task) `src/memory/constants.ts` 작성: `MEMORY_INDEX_FILE = "MEMORY.md"`, `MAX_MEMORY_BYTES = 10_000`, `AGENT_MD_FILENAMES = ["AGENT.md", "CLAUDE.md"]`

#### Success Criteria
- `bun typecheck` (`npx tsc --noEmit`) 에러 0건
- `paths.getProjectMemoryDir("abc123")` 호출 시 `~/.coreline-agent/projects/abc123/memory` 경로 반환
- 타입 export 확인: `MemoryType`, `MemoryEntry`, `AgentMdFile` 모두 사용 가능

#### Test Cases
- (historical task) TC-I0.1: `getProjectMemoryDir("deadbeef12345678")` → `~/.coreline-agent/projects/deadbeef12345678/memory`
- (historical task) TC-I0.2: `ensureProjectMemoryDir("test123")` 호출 → 해당 디렉토리 생성 확인
- (historical task) TC-I0.3: 타입 가드: `"user"` is `MemoryType` true, `"foo"` is `MemoryType` false (런타임 타입 헬퍼)
- (historical task) TC-I0.E1: `ensureProjectMemoryDir("")` → 빈 hash는 `Error` throw

#### Testing Instructions
```bash
cd /Users/hwanchoi/projects/claude-code/coreline-agent
npx tsc --noEmit
bun test tests/memory-basic.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I1: Project ID (cwd → hash)
> 프로젝트 식별자 생성, 격리된 메모리 공간 확보
> Dependencies: Phase I0
> **Phase I2, I3과 병렬 가능**

#### Tasks
- (historical task) `src/memory/project-id.ts` 작성:
  - `getProjectId(cwd: string): string` — SHA256 해시 후 앞 16자 반환
  - 내부: `createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)`
  - `writeProjectMetadata(cwd: string): void` — `projects/{hash}/metadata.json` 생성 (cwd 원본, createdAt)
  - `readProjectMetadata(hash: string): { cwd: string; createdAt: string } | null`

#### Success Criteria
- 동일 cwd 입력 시 동일 hash 반환 (결정적)
- 다른 cwd 입력 시 다른 hash
- `~/.coreline-agent/projects/{hash}/metadata.json` 실제로 생성됨

#### Test Cases
- (historical task) TC-I1.1: `getProjectId("/tmp/foo")` 두 번 호출 → 같은 값
- (historical task) TC-I1.2: `getProjectId("/tmp/foo")` vs `getProjectId("/tmp/bar")` → 다른 값
- (historical task) TC-I1.3: `getProjectId("/tmp/foo")` vs `getProjectId("/tmp/../tmp/foo")` → 같은 값 (resolve)
- (historical task) TC-I1.4: `writeProjectMetadata("/tmp")` 후 `readProjectMetadata(hash)` → `{ cwd: "/tmp", createdAt: ISO }`
- (historical task) TC-I1.E1: `getProjectId("")` → Error throw
- (historical task) TC-I1.E2: `readProjectMetadata("nonexistent")` → null

#### Testing Instructions
```bash
bun test tests/memory-basic.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I2: AGENT.md / CLAUDE.md Loader
> cwd에서 상위로 올라가며 프로젝트 지시사항 파일 탐색
> Dependencies: Phase I0
> **Phase I1, I3과 병렬 가능**

#### Tasks
- (historical task) `src/memory/agent-md-loader.ts` 작성:
  - `findAgentMd(cwd: string): AgentMdFile[]` — cwd부터 상위로 올라가며 AGENT.md, CLAUDE.md 수집. `.git` 디렉토리 발견하면 중단. 홈 디렉토리 넘지 않음
  - `loadAgentMdContent(files: AgentMdFile[]): string` — 모든 파일 내용을 구분자로 연결
  - 파일 크기 상한: 각 50KB, 총 200KB

#### Success Criteria
- cwd 위에 AGENT.md 있으면 발견
- 부모 디렉토리에 CLAUDE.md 있으면 발견 (상위 우선)
- `.git` 디렉토리 있는 곳에서 탐색 중단
- 파일이 없으면 빈 배열 반환

#### Test Cases
- (historical task) TC-I2.1: 테스트 디렉토리에 AGENT.md 생성 → `findAgentMd(dir)` 결과 1개, path 정확
- (historical task) TC-I2.2: 부모에 CLAUDE.md, 현재에 AGENT.md → 결과 2개, 순서: 현재→부모
- (historical task) TC-I2.3: `.git` 있는 repo root 이상으로 탐색 안함
- (historical task) TC-I2.4: 파일 없음 → 빈 배열
- (historical task) TC-I2.5: `loadAgentMdContent()` → 파일 내용을 `--- {path} ---\n{content}` 형식으로 연결
- (historical task) TC-I2.E1: 읽을 수 없는 파일 (권한 없음) → 스킵 + stderr 경고
- (historical task) TC-I2.E2: 50KB 초과 파일 → truncate + 경고

#### Testing Instructions
```bash
bun test tests/memory-basic.test.ts -t "agent-md"
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I3: Memory Parser
> YAML frontmatter + markdown body 파싱/직렬화
> Dependencies: Phase I0
> **Phase I1, I2와 병렬 가능**

#### Tasks
- (historical task) `src/memory/memory-parser.ts` 작성:
  - `parseMemoryFile(content: string): { frontmatter: Record<string, unknown>; body: string }` — `---\n...---\n본문` 파싱
  - `serializeMemoryFile(entry: MemoryEntry): string` — frontmatter + body 직렬화
  - `validateMemoryType(type: string): type is MemoryType` — 런타임 검증
  - 의존성: 기존 `yaml` 패키지 재사용

#### Success Criteria
- Claude Code 포맷 호환: `---\nname: X\ndescription: Y\ntype: user\n---\n본문`
- frontmatter 없으면 → `{ frontmatter: {}, body: 전체 }` 반환 (fallback)
- 직렬화 후 재파싱 시 동일 결과 (라운드트립)

#### Test Cases
- (historical task) TC-I3.1: 정상 메모리 파일 파싱 → frontmatter.name, body 정확
- (historical task) TC-I3.2: frontmatter 없는 파일 → body에 전체 내용
- (historical task) TC-I3.3: `validateMemoryType("user")` → true
- (historical task) TC-I3.4: `validateMemoryType("invalid")` → false
- (historical task) TC-I3.5: 라운드트립: serialize → parse → 원본과 동일
- (historical task) TC-I3.E1: 깨진 YAML frontmatter → body 전체로 fallback + stderr 경고
- (historical task) TC-I3.E2: 빈 입력 → `{ frontmatter: {}, body: "" }`

#### Testing Instructions
```bash
bun test tests/memory-parser.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I4: ProjectMemory Class — Integration
> 프로젝트별 메모리 로드/저장/인덱스 관리
> Dependencies: Phase I1, I2, I3

#### Tasks
- (historical task) `src/memory/project-memory.ts` 작성:
  - `class ProjectMemory { constructor(cwd: string) }` — 초기화 시 projectId, memoryDir 세팅
  - `loadAll(): { agentMd: string; memoryIndex: string; entries: MemoryEntry[] }` — AGENT.md + MEMORY.md + 개별 메모리 파일 전부 로드
  - `writeEntry(entry: MemoryEntry): void` — 메모리 파일 쓰기 + MEMORY.md 인덱스에 줄 추가
  - `readEntry(name: string): MemoryEntry | null`
  - `listEntries(): MemoryIndexEntry[]` — MEMORY.md에서 파싱
  - `deleteEntry(name: string): boolean`
- (historical task) `src/memory/index.ts` 작성: 모듈 public export

#### Success Criteria
- `new ProjectMemory("/tmp/foo").loadAll()` 호출 시 디렉토리 자동 생성
- `writeEntry({ name: "test", ... })` → 파일 생성 + MEMORY.md 갱신
- 연속 `writeEntry` 여러 번 → MEMORY.md에 중복 없이 추가

#### Test Cases
- (historical task) TC-I4.1: 빈 프로젝트 `loadAll()` → `{ agentMd: "", memoryIndex: "", entries: [] }`
- (historical task) TC-I4.2: `writeEntry({ name: "user_profile", type: "user", description: "내 설정", body: "Bun 사용" })` → 파일 존재 + MEMORY.md에 라인
- (historical task) TC-I4.3: `writeEntry` 두 번 (같은 name) → 덮어쓰기, MEMORY.md 중복 없음
- (historical task) TC-I4.4: `writeEntry` → `readEntry(name)` 라운드트립
- (historical task) TC-I4.5: `listEntries()` → 인덱스 순서대로 반환
- (historical task) TC-I4.6: `deleteEntry("user_profile")` → 파일 삭제 + MEMORY.md 라인 제거 + true 반환
- (historical task) TC-I4.E1: `readEntry("nonexistent")` → null
- (historical task) TC-I4.E2: `deleteEntry("nonexistent")` → false
- (historical task) TC-I4.E3: 잘못된 `type` 필드 → 에러 throw

#### Testing Instructions
```bash
bun test tests/memory-integration.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I5: MemoryRead / MemoryWrite Tools
> 에이전트가 자율적으로 메모리 읽고 쓸 수 있는 도구
> Dependencies: Phase I4

#### Tasks
- (historical task) `src/tools/memory-read/memory-read-tool.ts`:
  - `buildTool()` 패턴, name: `"MemoryRead"`
  - input: `{ name?: string }` — name 없으면 전체 목록, 있으면 해당 entry
  - output: `{ entries?: MemoryIndexEntry[]; entry?: MemoryEntry }`
  - `isReadOnly: () => true`
  - `checkPermissions: () => { behavior: "allow" }`
- (historical task) `src/tools/memory-write/memory-write-tool.ts`:
  - `buildTool()` 패턴, name: `"MemoryWrite"`
  - input: `{ name: string; type: "user"|"feedback"|"project"|"reference"; description: string; body: string }`
  - Zod validation: name은 `^[a-z][a-z0-9_]*$`, 최대 50자. body 최대 5KB
  - output: `{ filePath: string; isNew: boolean }`
  - `isReadOnly: () => false`
  - `checkPermissions: () => { behavior: "allow" }` — 에이전트 자기 쓰기는 신뢰
- (historical task) 두 도구 모두 context에 ProjectMemory 인스턴스 접근 필요. `ToolUseContext` 확장:
  - `projectMemory?: ProjectMemory` 필드 추가
  - `src/tools/types.ts` 수정

#### Success Criteria
- Tool 레지스트리에 두 도구 등록 시 LLM tool definitions에 포함
- MemoryWrite 후 MemoryRead로 같은 name 조회 → 동일 내용
- Zod validation 실패 시 명확한 에러 메시지

#### Test Cases
- (historical task) TC-I5.1: MemoryWrite `{ name: "user_profile", type: "user", description: "설정", body: "Bun 사용" }` → 성공 + 파일 경로 반환
- (historical task) TC-I5.2: MemoryRead (no name) → 전체 목록 반환
- (historical task) TC-I5.3: MemoryRead `{ name: "user_profile" }` → 단일 entry 반환
- (historical task) TC-I5.4: MemoryWrite 같은 name 두 번 → 두 번째는 `isNew: false`
- (historical task) TC-I5.5: MemoryRead `{ name: "nonexistent" }` → isError true
- (historical task) TC-I5.E1: MemoryWrite name에 공백 포함 → Zod error
- (historical task) TC-I5.E2: MemoryWrite type이 잘못된 값 → Zod error
- (historical task) TC-I5.E3: body 5KB 초과 → Zod error

#### Testing Instructions
```bash
bun test tests/memory-integration.test.ts -t "tool"
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I6: System Prompt Injection + CLI Wiring
> 대화 시작 시 AGENT.md + MEMORY.md 자동 로드, 도구 등록
> Dependencies: Phase I5

#### Tasks
- (historical task) `src/agent/system-prompt.ts` 수정:
  - `buildSystemPrompt()` 시그니처 확장: `(cwd, tools, projectMemory?)`
  - `projectMemory.loadAll()` 호출 결과 사용
  - 섹션 추가:
    - `# Project Instructions` (AGENT.md/CLAUDE.md 내용)
    - `# Memory` (MEMORY.md 내용 + 10KB 상한)
  - 메모리 내용에는 "자율적으로 MemoryWrite 도구를 써서 이 메모리를 업데이트하라" 가이드 추가
- (historical task) `src/index.ts` 수정:
  - `MemoryReadTool`, `MemoryWriteTool` import
  - `ALL_TOOLS` 배열에 추가
  - `const projectMemory = new ProjectMemory(process.cwd())` 생성
  - `createAppState()` 호출 시 projectMemory 전달
  - `buildSystemPrompt()`에 projectMemory 전달
- (historical task) `src/agent/context.ts` 수정:
  - `AppState`에 `projectMemory: ProjectMemory` 필드 추가
  - `createAppState()` 옵션에 추가
  - `toToolUseContext()`에서 context에 projectMemory 포함
- (historical task) `src/tools/types.ts` 수정:
  - `ToolUseContext`에 `projectMemory?: ProjectMemory` 필드 추가 (Phase I5에서 이미 함)

#### Success Criteria
- 프로젝트 cwd에 AGENT.md 생성 후 CLI 실행 → 시스템 프롬프트에 해당 내용 포함
- MemoryWrite 호출 후 재시작 → 시스템 프롬프트에 해당 메모리 포함
- `--verbose` 플래그 시 "loaded N memory entries" 로그 출력

#### Test Cases
- (historical task) TC-I6.1: AGENT.md 생성 후 `buildSystemPrompt` → "Project Instructions" 섹션에 내용 포함
- (historical task) TC-I6.2: MemoryWrite 후 `buildSystemPrompt` → "Memory" 섹션에 name/description 포함
- (historical task) TC-I6.3: 메모리 파일 없음 → 해당 섹션 생략 (빈 문자열 아님)
- (historical task) TC-I6.4: 메모리 내용 10KB 초과 → truncate + 경고 주석
- (historical task) TC-I6.5: tool 레지스트리에 MemoryRead, MemoryWrite 포함됨
- (historical task) TC-I6.E1: projectMemory undefined → 크래시 없이 기존 프롬프트 반환

#### Testing Instructions
```bash
# 1. 임시 프로젝트 디렉토리에서 테스트
mkdir -p /tmp/cl-agent-test && cd /tmp/cl-agent-test
echo "# AGENT.md\nUse Bun only." > AGENT.md

# 2. 시스템 프롬프트 확인 (mock runner)
bun test tests/memory-integration.test.ts -t "system prompt"

# 3. 실제 실행 확인
cd /Users/hwanchoi/projects/claude-code/coreline-agent
bun run src/index.ts -p "echo memory loaded" --verbose 2>&1 | grep -i "memory\|AGENT"
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase I7: E2E Tests + Documentation
> 전체 플로우 검증 + 사용자 문서
> Dependencies: Phase I6

#### Tasks
- (historical task) `tests/memory-e2e.test.ts` 작성:
  - E2E-1: 빈 프로젝트 → MemoryWrite → 다음 agentLoop에서 해당 내용이 system prompt에 포함됨 확인 (mock provider)
  - E2E-2: AGENT.md 있는 프로젝트 → 자동 로드되어 system prompt에 포함
  - E2E-3: 두 개 다른 cwd → 서로 격리 (hash가 다르므로 서로의 메모리 접근 불가)
- (historical task) `docs/memory-system.md` 작성 — 사용자 문서:
  - 개념 설명
  - AGENT.md 예시
  - MEMORY.md 구조
  - 사용 패턴 ("LLM에게 기록하라고 지시")
- (historical task) `README.md` 업데이트 (있으면) — Memory section 추가

#### Success Criteria
- 전체 테스트 ≥ 160개 통과
- `tsc --noEmit` 에러 0건
- 수동 검증: 실제 Ollama로 "내 이름은 X야, 기억해줘" → MemoryWrite 호출 → 재시작 후 "내 이름 뭐야?" → 정답

#### Test Cases
- (historical task) TC-I7.1: E2E-1 시나리오 → 성공
- (historical task) TC-I7.2: E2E-2 시나리오 → 성공
- (historical task) TC-I7.3: E2E-3 시나리오 → 성공 (격리 확인)
- (historical task) TC-I7.4: 수동 — Ollama + qwen2.5-coder로 "내 runtime은 Bun이야" → 재시작 후 물어보면 기억

#### Testing Instructions
```bash
# 전체 테스트
bun test

# 수동 E2E
cd /Users/hwanchoi/projects/claude-code/coreline-agent
rm -rf ~/.coreline-agent/projects  # 초기화
bun run src/index.ts -p "Remember that I use Bun runtime. Use MemoryWrite to save this." 2>&1
bun run src/index.ts -p "What runtime do I use?" 2>&1
# 두 번째 명령에서 "Bun"이 응답에 포함되어야 함
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 근본 원인 식별
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

## 5. Integration & Verification (통합 검증)

### 5.1 Integration Test Plan
- (historical task) E2E-1: 빈 프로젝트 디렉토리 → CLI 첫 실행 → 자동으로 project dir 생성됨
- (historical task) E2E-2: "내 이름은 홍길동" → MemoryWrite → 재시작 → "내 이름 뭐야?" → "홍길동" 응답
- (historical task) E2E-3: 프로젝트 A에서 저장 → 프로젝트 B에서 접근 불가 (격리)
- (historical task) E2E-4: AGENT.md 파일 변경 → 다음 실행 시 변경된 내용 로드
- (historical task) E2E-5: Git repo root 위로는 탐색하지 않음

### 5.2 Manual Verification Steps
1. `rm -rf ~/.coreline-agent/projects` 로 메모리 초기화
2. `cd /tmp && mkdir cl-test && cd cl-test`
3. `echo "# AGENT.md\nNEVER use TypeScript, always use JavaScript." > AGENT.md`
4. `bun run /path/to/coreline-agent/src/index.ts -p "What language should I use?"` → 응답에 "JavaScript" 포함 확인
5. `bun run /path/to/coreline-agent/src/index.ts -p "Remember I hate semicolons. Save this using MemoryWrite."` → MemoryWrite 호출 확인
6. `ls ~/.coreline-agent/projects/*/memory/` → 메모리 파일 확인
7. 다시 `bun run ... -p "What are my coding preferences?"` → "no semicolons" 응답 확인

### 5.3 Rollback Strategy
- Git revert로 Phase별 롤백
- 메모리 파일은 사용자 홈에 있으므로 코드 rollback 시 영향 없음
- 문제 시 `rm -rf ~/.coreline-agent/projects` 로 완전 초기화 가능

---

## 6. Edge Cases & Risks (엣지 케이스 및 위험)

| 위험 요소 | 영향도 | 완화 방안 |
|-----------|--------|-----------|
| LLM이 메모리에 개인정보/비밀 저장 | 높음 | Memory 디렉토리에 sensitive flag 옵션, `--no-memory` CLI flag |
| 메모리 파일 충돌 (여러 프로세스) | 낮음 | 단일 프로세스 가정, 나중에 file lock 추가 |
| cwd 이동 시 잘못된 프로젝트 인식 | 중간 | resolve(cwd) 사용, AGENT.md 탐색 시 git root 활용 |
| 메모리가 너무 커서 컨텍스트 폭발 | 중간 | 10KB 상한 + 컨텍스트 compaction 연동 |
| LLM이 잘못된 name으로 MemoryWrite | 낮음 | Zod 스키마로 `^[a-z][a-z0-9_]*$` 강제 |
| 프로젝트 ID 해시 충돌 | 극히 낮음 | SHA256 앞 16자 (2^64 공간) |
| AGENT.md 읽기 권한 없음 | 낮음 | try/catch 스킵 + stderr 경고 |
| 로컬 LLM의 MemoryWrite JSON 정확도 | 중간 | ReAct fallback 파서 (이미 있음) + 명확한 system prompt 예시 |
| 기존 사용자의 세션과의 호환성 | 낮음 | 메모리는 새 디렉토리(`projects/`)이므로 기존 `sessions/` 영향 없음 |

---

## 7. Execution Rules (실행 규칙)

1. **독립 모듈**: 각 Phase는 독립적으로 구현하고 테스트한다
2. **완료 조건**: 모든 태스크 체크박스 체크 + 모든 테스트 통과
3. **테스트 실패 워크플로우**: 에러 분석 → 근본 원인 수정 → 재테스트 → 통과 후에만 다음 Phase 진행
4. **Phase 완료 기록**: 체크박스를 체크하여 이 문서에 진행 상황 기록
5. **병렬 실행**: Phase I1 + I2 + I3는 동시 진행 가능. Phase I4부터 순차
6. **기존 테스트 유지**: 현재 143개 테스트 전부 통과해야 함. 메모리 통합 후에도 유지
7. **언어**: 메모리 내용은 한국어/영어 양쪽 지원 (모델 판단에 맡김)
