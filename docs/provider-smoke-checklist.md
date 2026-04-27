# Provider Smoke Checklist

실제 API 키 또는 로컬 OpenAI-compatible 엔드포인트가 준비된 경우 아래 매트릭스 순서로 smoke test를 실행한다.

## 0. Automation entry points

- CI-safe / manual / nightly-safe 분리는 [Provider Smoke CI / Automation](provider-smoke-ci.md) 를 따른다.
- 권장 실행은 package scripts를 사용한다.

```bash
bun run smoke:provider:ci-safe
bun run smoke:provider:manual
bun run smoke:provider:compatible
bun run smoke:provider:cloud
bun run smoke:provider:nightly-safe
bun run smoke:provider:all
```

## 1. Smoke matrix

| 범위 | 실행 명령 | 필요 조건 | 상태 |
|---|---|---|---|
| local-qwen | `CORELINE_RUN_PROVIDER_SMOKE=1 CORELINE_PROVIDER_SMOKE_TARGETS=compatible CORELINE_OAI_BASE_URL=http://localhost:11434/v1 CORELINE_OAI_MODEL='qwen2.5-coder:7b' bun test tests/provider-smoke.test.ts` | `ollama`/OpenAI-compatible endpoint가 `localhost:11434`에서 동작 | **PASS** (2026-04-18) |
| local-gemma | `CORELINE_RUN_PROVIDER_SMOKE=1 CORELINE_PROVIDER_SMOKE_TARGETS=compatible CORELINE_OAI_BASE_URL=http://localhost:11434/v1 CORELINE_OAI_MODEL='gemma4:e2b' bun test tests/provider-smoke.test.ts` | `ollama`/OpenAI-compatible endpoint가 `localhost:11434`에서 동작 | **PASS** (2026-04-18) |
| anthropic | `CORELINE_RUN_PROVIDER_SMOKE=1 CORELINE_PROVIDER_SMOKE_TARGETS=anthropic bun test tests/provider-smoke.test.ts` | `ANTHROPIC_API_KEY` + `CORELINE_ANTHROPIC_MODEL` | **BLOCKED** (2026-04-18: 이 환경에 키가 없음) |
| openai | `CORELINE_RUN_PROVIDER_SMOKE=1 CORELINE_PROVIDER_SMOKE_TARGETS=openai bun test tests/provider-smoke.test.ts` | `OPENAI_API_KEY` + `CORELINE_OPENAI_MODEL` | **BLOCKED** (2026-04-18: 이 환경에 키가 없음) |
| gemini | `CORELINE_RUN_PROVIDER_SMOKE=1 CORELINE_PROVIDER_SMOKE_TARGETS=gemini bun test tests/provider-smoke.test.ts` | `GOOGLE_API_KEY` + `CORELINE_GEMINI_MODEL` | **BLOCKED** (2026-04-18: 이 환경에 키가 없음) |

## 2. 기본 검증

```bash
bun run typecheck
bun run build
bun test tests/provider-smoke.test.ts
```

기본적으로 `tests/provider-smoke.test.ts`는 opt-in 이므로 실제 호출은 일어나지 않는다.

## 3. 실호출 smoke test

선택 가능한 변수:

- `CORELINE_RUN_PROVIDER_SMOKE`
- `CORELINE_PROVIDER_SMOKE_TARGETS`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `CORELINE_OAI_BASE_URL`
- `CORELINE_OAI_MODEL`
- `CORELINE_OAI_API_KEY`
- `CORELINE_ANTHROPIC_MODEL`
- `CORELINE_OPENAI_MODEL`
- `CORELINE_GEMINI_MODEL`

## 4. 실행 기준

- local smoke는 가능한 경우 우선 `compatible` 타겟만 지정해서 돌린다.
- cloud smoke는 키가 없는 경우 “미실행”으로 기록하고, 억지로 대체 실행하지 않는다.
- smoke test는 장기 대화나 tool call이 아니라 “연결 가능성 확인” 수준으로만 사용한다.
- 현재 하니스는 `anthropic` / `openai` / `gemini` / `openai-compatible`만 직접 다룬다.
- `chatgpt` / `claude`는 이 smoke 하니스 범위 밖이며, 별도 인증 경로가 필요하다.

## 5. 기대 결과

- 각 provider test가 `OK` 응답을 포함한 text delta를 반환
- 실패 시 인증/네트워크/모델 설정 문제를 먼저 확인
- smoke 결과는 날짜와 함께 PASS/BLOCKED로 남긴다
- 범위 밖 provider는 BLOCKED가 아니라 **OUT-OF-SCOPE**로 남긴다

## 6. 2026-04-18 재검증 메모

- `bun run smoke:provider:ci-safe` ✅
- `local-qwen` compatible smoke ✅
- `local-gemma` compatible smoke ✅
- cloud smoke 하니스 실행은 가능했지만 실제 API 호출 기준으로는 **BLOCKED**
  - 이유: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` 없음
