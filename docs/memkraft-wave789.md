# Wave 7/8/9 — User Guide

이 문서는 coreline-agent 의 Wave 7/8/9 통합으로 추가된 기능을
실제 사용자 관점에서 설명한다. Wave 1-6 통합과 함께 동작하며, 모든 신규
frontmatter 필드는 optional 이므로 기존 메모리는 그대로 보존된다.

## 1. Overview

기존 coreline-agent 의 메모리 시스템(3-tier core/recall/archival)에
**시간성 사실 기록(bitemporal facts)**, **점진 망각(decay/tombstone)**,
**위키 링크 그래프(wiki links)**, **문서 청킹(chunking)** 4 가지
Wave 7 메모리 확장이 추가되었다.

이어서 운영 회복력을 위한 **인시던트 레이어(Wave 8)** 와 결정/RCA/런북을
포함한 **결정 기록 + 자가 회복 레이어(Wave 9)** 가 도입되었다. 인시던트는
도구 실패가 임계치(기본 3회)에 도달하면 자동으로 승격되고,
`computeRCA` 가 hypothesis 점수와 매칭 runbook 을 함께 제안한다.
`/evidence-first` 한 번의 호출로 메모리 / 인시던트 / 결정 3 도메인을 동시에 검색할 수 있다.

## 2. Frontmatter Schema (확장 필드)

| 필드 | 도입 | 타입 | 적용 |
|---|---|---|---|
| `tier` | Wave 1-6 | `core` \| `recall` \| `archival` | 메모리 우선순위 |
| `lastAccessed` | Wave 1-6 | ISO date | tiering / decay 입력 |
| `accessCount` | Wave 1-6 | number | auto-promote |
| `importance` | Wave 1-6 | `low` \| `med` \| `high` | working-set 우선 |
| `decayWeight` | Wave 7 | `[0, 1]` 실수 | 망각 가중치 |
| `decayCount` | Wave 7 | number | 적용 횟수 |
| `tombstoned` | Wave 7 | boolean | soft-delete 여부 |
| `tombstonedAt` | Wave 7 | ISO datetime | tombstone 시점 |
| `validFrom` | Wave 7 | ISO date | 사실 유효 시작 |
| `validTo` | Wave 7 | ISO date | 사실 유효 종료 |
| `recordedAt` | Wave 7 | ISO datetime | 기록 시점 |

인시던트 / 결정 / 런북은 별도 디렉터리에 저장되며 자체 frontmatter 를 가진다
(상세는 `src/agent/{incident,decision,runbook}/types.ts` 참조).

## 3. 8 Usage Scenarios

### 3.1 Bitemporal facts — 인물의 직책 변천사

```
/fact add SimonKim role CTO --valid-from 2018-01-01 --valid-to 2020-02-29
/fact add SimonKim role CEO --valid-from 2020-03-01
/fact at SimonKim role --as-of 2019-06-01 # → CTO
/fact at SimonKim role --as-of 2026-01-01 # → CEO
/fact history SimonKim role
```

### 3.2 Decay lifecycle — 가중치 감쇠 및 복구

```
/memory decay-apply old_note --rate 0.5 # weight: 1.0 → 0.5
/memory decay-list --below 0.6 # 후보 조회
/memory decay-tombstone old_note # soft-delete
/memory decay-restore old_note # weight 1.0, tombstoned=false
```

### 3.3 Wiki link graph — N-hop 탐색

```
/link scan # forward.json 재구축
/link forward Alpha.md # ["Bravo", "Charlie"]
/link graph Alpha --hops 2 # BFS 그래프
/link orphans # 정의되지 않은 엔티티
```

### 3.4 Document chunking — 정확한 substring 검색

```
# 큰 문서를 IngestDocument 로 chunk 분할
/search-precise "exact phrase here" --top-k 5
```

`searchPrecise` 는 모든 query 단어가 동시에 들어있는 chunk 를 우선 반환하며,
실패 시 fuzzy 토큰 overlap fallback 으로 전환된다(`fallbackUsed: true`).

### 3.5 Incident auto-escalation — 도구 실패 3회 → 자동 인시던트

세션 안에서 동일 도구가 임계치만큼 실패하면 자동으로 인시던트가 생성된다.

```
/incident list --status open
/incident show inc-20260426-093012-ab12cd34
/incident confirm inc-...-ab12cd34 "Stale DNS cache on CI node"
/incident resolve inc-...-ab12cd34 --resolution "DNS flushed; retry succeeds"
```

기본 임계치 3 — `INCIDENT_ESCALATION_THRESHOLD` 환경변수로 조정.

### 3.6 RCA — hypothesis 점수 + runbook 제안

```
/rca inc-20260426-093012-ab12cd34 --strategy heuristic
```

응답에는 hypothesis 가 점수 내림차순으로 정렬되어 나오고, 첫 번째 symptom 으로
매칭된 runbook 이 함께 제안된다 (`touch:false` — 통계 미변동).

### 3.7 Decision store — What/Why/How 강제

```
/decision record \
 --what "Use Bun for all CI scripts" \
 --why "Faster cold-start than node" \
 --how "Update Makefile + Dockerfile" \
 --tags build,ci
/decision list --status accepted --tag build
/decision show dec-20260426-use-bun
/decision update dec-20260426-use-bun --outcome "CI 30% faster"
```

`source: "auto-convergence"` 는 plan-execute 의 convergence-gate 가 통과했을 때
시스템이 자동으로 기록한다 (env 로 비활성화 가능 — §5).

### 3.8 Cross-domain evidence-first 검색

```
/evidence-first "timeout" --limit 20
```

3개 도메인(memory recall, incident, decision)을 `Promise.all` 로 병렬 검색하여
점수 내림차순 머지한 결과를 반환한다 (severity / status 가중치 적용).

## 4. Slash Commands Reference

### Facts

| 명령 | 기능 |
|---|---|
| `/fact add <entity> <key> <value> [--valid-from FROM] [--valid-to TO]` | 사실 추가 |
| `/fact at <entity> <key> [--as-of DATE]` | 시점 조회 |
| `/fact history <entity> [<key>]` | 사실 이력 |
| `/fact invalidate <entity> <key> [--invalid-at DATE]` | open interval 마감 |
| `/fact list <entity>` | 전체 사실 |
| `/fact keys <entity>` | 사용된 key 목록 |

### Decay

| 명령 | 기능 |
|---|---|
| `/memory decay-apply <name> [--rate R]` | 단건 decay 적용 |
| `/memory decay-list [--below T] [--include-tombstoned]` | 임계치 미만 엔트리 |
| `/memory decay-restore <name>` | 가중치/tombstone 복구 |
| `/memory decay-run [--older-than-days N] [--access-count-lt N] [--weight-gt N] [--rate R]` | 일괄 decay |
| `/memory decay-tombstone <name>` | soft-delete |
| `/memory decay-is-tombstoned <name>` | tombstone 여부 확인 |

### Links

| 명령 | 기능 |
|---|---|
| `/link scan [<path>]` | forward.json 재구축 (인크리멘탈 가능) |
| `/link forward <source>` | 특정 파일의 outbound 엔티티 |
| `/link graph <entity> [--hops N]` | N-hop BFS (cap=`LINK_MAX_HOPS`) |
| `/link orphans` | 정의 없는 엔티티 |

### Precise Search

| 명령 | 기능 |
|---|---|
| `/search-precise <query> [--top-k N] [--threshold N]` | 정확/fuzzy fallback 검색 |

### Incident

| 명령 | 기능 |
|---|---|
| `/incident list [--severity S] [--status S]` | 인시던트 목록 |
| `/incident show <id>` | 단건 상세 |
| `/incident update <id> [--hypothesis ...] [--confirm ...] [--evidence ...]` | 부분 업데이트 |
| `/incident confirm <id> <hypothesis>` | hypothesis 확정 |
| `/incident resolve <id> --resolution "..."` | 해결 처리 |

### Decision

| 명령 | 기능 |
|---|---|
| `/decision list [--status S] [--tag T]` | 결정 목록 |
| `/decision show <id>` | 단건 상세 |
| `/decision record --what "..." --why "..." --how "..." [--tags ...]` | 결정 기록 |
| `/decision update <id> --outcome "..."` | outcome 업데이트 |
| `/evidence-first <query> [--limit N]` | 3 도메인 동시 검색 |

### Runbook

| 명령 | 기능 |
|---|---|
| `/runbook list [--tag T]` | 런북 목록 |
| `/runbook show <id>` | 단건 상세 |
| `/runbook match <symptom>` | 증상 → 런북 매칭 |
| `/runbook apply <id> [--dry-run]` | 적용 (dry-run 기본) |
| `/runbook record --pattern "..." --steps "s1; s2; ..."` | 런북 등록 |

#### Runbook Sandbox Levels

`/runbook apply` 가 실제 명령을 실행할 때 사용하는 격리 단계.
기본값은 dry-run (D12) 으로 어떤 명령도 실행되지 않는다.

| 레벨 | 환경변수 | 동작 |
|------|---------|------|
| **dry-run** (기본) | (없음) | 명령을 실행하지 않고 모든 step 을 `simulated` 로 기록 |
| **soft** | `RUNBOOK_SANDBOX_ENABLE=true` + `RUNBOOK_SANDBOX_LEVEL=soft` | best-effort 격리 — `tmpdir` cwd + env scrubbing (HOME/USER/TOKEN/KEY 제거 + minimal PATH) + post-exec 파일 탈출 검사 + 네트워크 차단 hint (HTTP_PROXY=http://localhost:1) |
| **hard** | (Wave 11+) | OS-level 격리 (Docker / firecracker / seccomp). 미구현. |

**Soft mode 한계** (코드: `src/agent/runbook/soft-sandbox.ts`, 테스트: `tests/runbook-soft-sandbox.test.ts`):

- syscall filter 없음 (seccomp 미사용)
- user namespace / process namespace 격리 없음
- 파일 시스템 탈출 검사는 mtime 기반 best-effort — race condition / 다른 프로세스 / FS mtime 해상도 한계 존재
- 신뢰할 수 있는 author 의 runbook 에만 사용 권장
- 악의적 입력에 대한 보안 경계가 아님
- `permission-gate` 는 soft / non-soft 모두에서 동일하게 위험 명령 (`rm -rf /`, `sudo`, fork bomb, …) 을 차단

### RCA

| 명령 | 기능 |
|---|---|
| `/rca <incidentId> [--strategy heuristic]` | RCA 보고서 (heuristic only MVP) |

## 5. Environment Variables

| 변수 | 기본값 | 효과 |
|---|---|---|
| `INCIDENT_ESCALATION_THRESHOLD` | 3 | 도구 실패 자동 인시던트 임계치 |
| `INCIDENT_SEVERITY_MAP` | (없음) | `bash:high,git:medium` 형식 도구→심각도 |
| `AUTO_RECORD_DECISIONS` | true | convergence-gate 통과 시 자동 결정 기록 |
| `FACTS_MAX_ENTRIES` | 500 | 엔티티 별 사실 적층 경고 임계치 |
| `MAX_CHUNKS_PER_DOC` | 1000 | trackDocument 폭주 방지 |
| `DECAY_DEFAULT_RATE` | 0.5 | `decayApply` 기본 rate |
| `LINK_MAX_HOPS` | 2 | `linkGraph` BFS 깊이 cap |
| `RUNBOOK_SANDBOX_ENABLE` | `false` | `true` 일 때만 `/runbook apply --no-dry-run` 가 실제 실행 |
| `RUNBOOK_SANDBOX_LEVEL` | (없음 = dry-run) | `soft` 시 best-effort 격리 (tmpdir cwd + env scrub). Wave 11+ 에서 `hard` 추가 예정 |

## 6. File Locations

```
~/.coreline-agent/projects/{projectId}/memory/
├── MEMORY.md # auto-digest (Wave 1-6)
├── *.md # 일반 메모리 엔트리
├── facts/ # Wave 7: bitemporal facts
│ └── <entity>.md
├── links/ # Wave 7: wiki link 그래프
│ └── forward.json # atomic write (.tmp → rename)
├── incidents/ # Wave 8
│ └── inc-{YYYYMMDD}-{HHMMSS}-{hash}.md
├── decisions/ # Wave 9
│ └── dec-{YYYYMMDD}-{slug}.md
├── runbooks/ # Wave 9
│ └── rb-{hash}.md
└── .memory/
 └── tombstones/ # Wave 7: soft-deleted entries
 └── <name>.md
```

## 7. 참고

- `docs/memory-system.md` — 메모리 시스템 전반(Wave 1-9)
- `docs/memkraft-integration.md` — Wave 1-6 통합 가이드
- `dev-plan/implement_20260425_150000.md` — Phase 0–10 구현 계획
- 모듈 코드: `src/memory/{facts,decay,links,chunking}.ts`,
 `src/agent/{incident,decision,runbook,rca}/`
