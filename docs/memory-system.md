# Memory System

`coreline-agent`는 프로젝트별 메모리 저장소를 사용해 반복되는 사용자 선호, 프로젝트 규칙, 피드백을 누적할 수 있다.

## Memory Tiers (메모리 레퍼런스 integration)

coreline-agent supports a 3-tier memory classification adapted from 메모리 레퍼런스.

| Tier | Purpose | Stale policy |
|------|---------|--------------|
| `core` | Always injected into system prompt (hot working set) | 180 days |
| `recall` | Default; included on demand via working set | 60 days |
| `archival` | Cold; searchable via `MemoryRecall` tool only | ∞ (never stale) |

### Memory types

| Type | Purpose | Default tier | Trigger |
|------|---------|--------------|---------|
| `user` | Per-user preferences/profile | core | manual + auto-summary |
| `feedback` | User-supplied feedback / corrections | core | manual + auto-summary |
| `project` | Project rules / conventions | core | manual + auto-summary |
| `reference` | Reference material (docs, examples) | recall | manual |
| `brand-spec` | Brand identity (logo/colors/fonts/tone) | core | manual only |

Frontmatter fields: `tier`, `lastAccessed`, `accessCount`, `importance`.

### Working Set

System prompt injects all `core` entries + most recently accessed `recall`
(limit `CORELINE_WORKING_SET_LIMIT`, default 8). `archival` entries are
never injected; use `MemoryRecall` to retrieve.

### Compaction & Promotion

- `/memory compact [--dry-run] [--max-chars N]` — archive old/low-importance entries
- `/memory promote [--dry-run]` — promote `recall` with `accessCount >= 3` to `core`
- `/memory digest` — generate `MEMORY.md` snapshot (auto-generated on session end)

See [memkraft-integration.md](memkraft-integration.md) for usage scenarios.

## 저장 위치

기본 경로:

```txt
~/.coreline-agent/projects/{projectId}/
```

구조:

```txt
projects/{projectId}/
├── metadata.json
└── memory/
 ├── MEMORY.md
 ├── user_profile.md
 ├── feedback_<topic>.md
 ├── project_<topic>.md
 └── reference_<topic>.md
```

## 프로젝트 식별

- `projectId = SHA256(resolve(cwd)).slice(0, 16)`
- 같은 프로젝트 경로는 항상 같은 메모리 공간을 사용한다.

## 자동 로드

대화 시작 시 아래 정보가 system prompt에 포함된다.

- 현재 작업 경로에서 상위로 탐색한 `AGENT.md`, `CLAUDE.md`
- 프로젝트 메모리 인덱스(`MEMORY.md`)

탐색은 `.git` 디렉토리를 만나면 중단한다.

## 도구

### MemoryRead

- 입력
 - `name?`
- 동작
 - `name`이 없으면 메모리 목록을 `MEMORY_READ_RESULT` 형식으로 반환
 - `name`이 있으면 해당 entry를 `MEMORY_READ_RESULT` 형식으로 반환
 - 기본 권한: allow

### MemoryRead 출력 형식

#### 목록 조회

```text
MEMORY_READ_RESULT
mode: list
summary: 1 memory entry available
count: 1

ENTRIES_START
1. name: runtime_pref
 type: user
 description: Preferred runtime
 file: runtime_pref.md
 preview: Use Bun for scripts.
ENTRIES_END

NEXT_STEP: Call MemoryRead with { "name": "<entry>" } to load one entry.
```

#### 단일 entry 조회

```text
MEMORY_READ_RESULT
mode: entry
summary: memory entry loaded
answer_hint: if the user's question matches this entry, answer from ENTRY_BODY_START to ENTRY_BODY_END directly
name: runtime_pref
type: user
description: Preferred runtime
file: runtime_pref.md

ENTRY_BODY_START
Use Bun for scripts.
ENTRY_BODY_END
```

#### 에러 응답

```text
MEMORY_READ_RESULT
mode: error
message: Memory entry not found: runtime_pref
```

이 형식은 모델이 다음 정보를 안정적으로 분리해서 읽도록 돕는다.

- `mode`와 `summary`는 응답 종류를 빠르게 판별한다.
- `ENTRIES_START` / `ENTRIES_END`는 목록을 구조적으로 구분한다.
- `ENTRY_BODY_START` / `ENTRY_BODY_END`는 메모리 본문과 메타데이터를 분리한다.

### MemoryWrite

- 입력
 - `name`
 - `type`: `user | feedback | project | reference`
 - `description`
 - `body`
- 동작
 - 메모리 파일 생성 또는 갱신
 - `MEMORY.md` 인덱스도 함께 갱신
 - AWS/GitHub/GitLab/OpenAI/Anthropic/Slack/npm token, private key, generic password/secret/token assignment 등 high-confidence secret을 감지하면 저장을 거부
 - 기본 권한: ask

MemoryWrite 후에는 같은 세션에서 바로 `MemoryRead`를 호출해 저장 결과를 확인할 수 있다.
이렇게 하면 저장 성공 여부와 실제 읽기 가능 여부를 함께 검증할 수 있다.

## 권장 사용

- `user`: 사용자의 지속적 선호
- `feedback`: 작업 방식에 대한 교정/피드백
- `project`: 프로젝트 룰, 금지사항, 컨벤션
- `reference`: 반복 참조가 필요한 외부 정보 요약

## 주의 사항

- 민감한 비밀값은 메모리에 저장하지 않는 것이 좋다.
- secret scanner는 match 값 자체를 반환/로그하지 않고 safe label만 반환한다.
- `redactSecrets`는 trace/status/export 계열에서 민감한 문자열을 `[REDACTED]`로 치환할 때 재사용할 수 있다.
- `MemoryWrite`는 프로젝트 맥락에서 오래 유지될 정보만 저장해야 한다.
- 현재 런타임 기준으로 `MemoryWrite`는 기본적으로 확인을 요구한다.
- `MemoryRead`는 읽기 전용이라 기본 허용된다.
- 별도의 memory 비활성 플래그는 아직 제공하지 않는다.

## 대화 예시

사용자:

```text
내 runtime은 Bun이야. 이거 기억해줘.
```

에이전트 내부 동작:

```json
{"name":"MemoryWrite","arguments":{"name":"runtime_preference","type":"user","description":"Preferred runtime","body":"Use Bun runtime for scripts and tests."}}
```

저장 결과 예시:

```text
~/.coreline-agent/projects/<projectId>/memory/runtime_preference.md
~/.coreline-agent/projects/<projectId>/memory/MEMORY.md
```

이후 재시작 후:

```text
사용자: 내 runtime이 뭐야?
에이전트: 이 프로젝트에서는 Bun runtime을 선호한다고 저장되어 있어.
```

## 자동 트리거 예시

다음처럼 장기적으로 유지될 정보가 있을 때 `MemoryWrite`를 쓰는 것이 적절하다.

- `이 규칙 기억해줘`
- `앞으로 테스트는 bun test로 돌려`
- `우리 프로젝트는 semicolon 안 써`
- `이 피드백을 다음에도 반영해`

다음과 같은 일회성 정보는 메모리에 저장하지 않는 편이 좋다.

- 지금 한 번만 필요한 로그 결과
- 곧 무효가 될 임시 경로
- 민감한 토큰, 비밀번호, API 키

## 수동 편집 가이드

사람이 직접 메모리 파일을 수정해도 된다.

1. `~/.coreline-agent/projects/{projectId}/memory/`로 이동
2. 원하는 `*.md` 메모리 파일을 편집
3. 필요하면 `MEMORY.md` 인덱스도 함께 정리
4. 다음 세션 시작 시 자동으로 다시 로드

권장 사항:

- 파일명은 소문자 + `_` 형태 유지
- `description`은 짧고 검색 가능하게 작성
- `body`는 미래의 에이전트가 바로 활용할 수 있게 구체적으로 작성

## AGENT.md 템플릿 예시

프로젝트 루트의 `AGENT.md`는 memory 시스템과 별개로 자동 로드된다.

```md
# Project Instructions

- Use Bun for scripts and tests.
- Prefer editing existing files over creating new ones.
- Run `bun test` before reporting completion.
- Do not change CI config unless explicitly asked.
```

`AGENT.md`는 프로젝트 공통 규칙에 적합하고, `MemoryWrite`는 사용자 선호/피드백/참조 메모에 적합하다.

## Wave 7-9 Extensions (메모리 레퍼런스)

메모리 레퍼런스 통합으로 메모리 시스템에 시간성(bitemporal), 점진 망각(decay), 위키 링크(links),
문서 청킹(chunking), 인시던트/결정/RCA/런북 레이어가 추가되었다. 모든 신규 필드는 optional —
기존 메모리는 그대로 작동한다.

### Bitemporal Facts

엔티티별 사실 기록은 `[[Entity]]` 패턴 기반으로 별도 파일(`memory/facts/<entity>.md`)에 적층된다.
각 라인은 `valid_from..valid_to` (사실이 적용되는 기간) 와 `recorded_at` (기록 시점)을 분리한다.
같은 시점을 두 번 다른 값으로 기록하면 `factAt` 은 가장 늦게 기록된 값을 반환한다 (corrections-first).

```ts
factAdd(mem, "SimonKim", "role", "CEO", { validFrom: "2020-03-01" });
const r = factAt(mem, "SimonKim", "role", { asOf: "2026-01-01" });
// r.value === "CEO"
```

### Decay + Tombstone

각 메모리 엔트리는 `decayWeight ∈ [0, 1]` 과 `decayCount` frontmatter 를 가진다.
`decayApply(name, rate)` 는 `weight *= (1 - rate)` 를 적용하고 라운딩한다 (메모리 레퍼런스 parity).
중요도가 낮아진 엔트리는 `decayTombstone` 으로 soft-delete 된다 (`<projectDir>/.memory/tombstones/`).
`decayRestore` 는 weight=1, count=0, tombstoned=false 로 되돌린다.

```ts
decayApply(mem, "old_recall", { decayRate: 0.5 });
decayTombstone(mem, "old_recall");
decayRestore(mem, "old_recall");
```

### Wiki Links

`[[Entity Name]]` 또는 `[[Entity|display]]` 패턴이 본문에서 추출되어
`<memoryDir>/links/forward.json` 단방향 인덱스로 저장된다 (atomic write).
`linkGraph(entity, {hops: 2})` 은 BFS 로 N-hop 그래프를, `linkOrphans` 은
정의되지 않은 엔티티를 반환한다.

```ts
linkScan(mem);
const fwd = linkForward(mem, "Alpha.md");
const graph = linkGraph(mem, "Alpha", { hops: 2 });
```

### Document Chunking

`IngestDocument` 도구 (`src/tools/ingest-document/`) 는 큰 문서를 word-level overlap 청크로 분할한다
(기본 size=500, overlap=50, MAX_CHUNKS_PER_DOC=1000). 부모 + chunk 엔트리가 모두 메모리에 기록된다.
`searchPrecise(query)` 는 정확한 substring 매칭을 우선 시도하고 (precision-first),
실패 시 토큰 오버랩 fuzzy fallback 으로 전환한다.

```ts
trackDocument(mem, "doc-id", longText, { chunkSize: 500, chunkOverlap: 50 });
const r = searchPrecise(mem, "exact phrase"); // r.fallbackUsed === false on hit
```

### Incident Layer (Wave 8)

`recordToolFailure(session, toolName, error)` 는 도구 실패를 카운트하고,
`INCIDENT_ESCALATION_THRESHOLD` (기본 3) 에 도달하면 `escalateToolFailure` 가 자동 인시던트를 생성한다.
인시던트는 `symptoms`, `evidence` (typed), `hypotheses` (status: testing/confirmed/rejected),
`affected`, `severity`, `tier` (open=core, resolved=archival) 를 가진다.

```ts
recordToolFailure(sessionId, "bash", "exit 127");
recordToolFailure(sessionId, "bash", "exit 127");
recordToolFailure(sessionId, "bash", "exit 127");
const id = escalateToolFailure(projectId, sessionId, "bash", 3);
```

### Decision Store

결정은 What/Why/How 3 필드를 강제하며 `~/.coreline-agent/projects/{id}/memory/decisions/` 에 기록된다.
`source: "auto-convergence"` 는 plan-execute convergence-gate 가 통과했을 때 자동 기록되는 결정이다.
`linkedIncidents` 를 지정하면 양방향 링크가 인시던트 파일의 `## Related` 섹션에도 추가된다.

```ts
const decId = decisionRecord(projectId,
 "Use Bun for all CI scripts", // what
 "Faster cold-start than node", // why
 "Update Makefile + Dockerfile", // how
 { tags: ["build"], linkedIncidents: ["inc-..."] }
);
```

### Brand Spec memory

`brand-spec` 는 프로젝트의 시각적 정체성(로고, 주/보조색, 배경, 타이포그래피, 톤, 금지 패턴) 을
한 곳에 모아두는 전용 메모리 타입이다. 디자인/UI 작업 중 색상·폰트·금지 표현을 매번 다시 설명하지
않도록 기본 tier 가 `core` 로 설정되어 시스템 프롬프트에 항상 주입된다. 이 타입은 자동 요약
대상이 아니며 수동으로만 생성·편집한다.

`/memory brand-spec init <name>` 으로 템플릿이 생성되며, `view` 는 본문 + 누락된 placeholder
경고를 출력하고, `edit` 는 외부 에디터로 열 수 있도록 파일 경로를 안내한다.

```bash
/memory brand-spec init acme # 템플릿 생성 → memory/brand-spec-acme.md
/memory brand-spec view acme # 본문 + warning 표시
/memory brand-spec edit acme # 파일 경로 안내
```

(개념은 디자인 레퍼런스 의 "core asset protocol" 에서 영감을 얻었으나, 모든 텍스트와 구현은
독립적으로 작성됨.)

### RCA + Runbook

`computeRCA(projectId, incidentId)` 은 heuristic-only MVP 로 hypothesis 점수, 매칭된 runbook,
관련 incident 를 반환한다. Runbook 은 `pattern → steps[]` 형태이며, `runbookMatch(symptom)`
가 패턴 유사도(literal substring + word overlap + regex) 와 confidence 를 합산해 정렬한다.
`runbookApply` 은 dry-run MVP — 실제 실행은 Wave 10+ sandbox 에 deferred.

```ts
runbookAdd(projectId, "Connection timeout",
 ["Flush DNS cache", "Retry with longer timeout"],
 { confidence: 0.7, verification: "tests pass in <30s" });

const report = computeRCA(projectId, incidentId);
// report.hypotheses[0].score, report.suggestedRunbooks[0].runbook
```

