# Provider Smoke CI / Automation

이 문서는 provider smoke를 어떤 진입점으로 돌릴지, 그리고 CI-safe / manual / nightly-safe를 어떻게 나눌지 정리한다.

## 권장 진입점

| 진입점 | 용도 | 실행 방식 |
|---|---|---|
| `bun run smoke:provider:ci-safe` | CI-safe | 실제 호출 없이 test 하니스만 확인 |
| `bun run smoke:provider:manual` | 수동 실행 | `CORELINE_RUN_PROVIDER_SMOKE=1` + 필요한 env를 직접 주입 |
| `bun run smoke:provider:compatible` | 로컬 OpenAI-compatible smoke | `CORELINE_PROVIDER_SMOKE_TARGETS=compatible` |
| `bun run smoke:provider:cloud` | cloud smoke | `anthropic,openai,gemini`만 실행 |
| `bun run smoke:provider:nightly-safe` | nightly-safe | cloud provider만 시도하고 env 없으면 skip |
| `bun run smoke:provider:all` | 전체 smoke | compatible + cloud를 모두 시도 |

## env gate 규칙

- `CORELINE_RUN_PROVIDER_SMOKE=1` 이어야 실제 호출이 발생한다.
- `CORELINE_PROVIDER_SMOKE_TARGETS`는 comma-separated target list다.
- target 값은 다음을 사용한다.
  - `compatible`
  - `anthropic`
  - `openai`
  - `gemini`
- target에 해당하는 인증/endpoint가 없으면 test는 skip되고, smoke는 BLOCKED 또는 OUT-OF-SCOPE로 기록한다.

## workflow env / secret / vars

| 이름 | 종류 | 용도 |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Anthropic smoke |
| `OPENAI_API_KEY` | secret | OpenAI smoke |
| `GOOGLE_API_KEY` | secret | Gemini smoke |
| `CORELINE_OAI_API_KEY` | secret | OpenAI-compatible smoke 인증 |
| `CORELINE_OAI_BASE_URL` | vars | OpenAI-compatible smoke endpoint |
| `CORELINE_OAI_MODEL` | vars | OpenAI-compatible smoke model |
| `CORELINE_ANTHROPIC_MODEL` | vars | Anthropic smoke model override |
| `CORELINE_OPENAI_MODEL` | vars | OpenAI smoke model override |
| `CORELINE_GEMINI_MODEL` | vars | Gemini smoke model override |

## CI-safe / manual / nightly-safe 분리

### CI-safe
- 목적: repo가 깨지지 않았는지 확인
- 외부 키/엔드포인트 불필요
- 추천 실행:
  - `bun run smoke:provider:ci-safe`

### Manual
- 목적: 로컬/외부 smoke를 필요할 때 수동 실행
- 외부 키 또는 OpenAI-compatible endpoint를 환경변수로 주입
- 추천 실행:
  - `bun run smoke:provider:manual`
  - 필요 시 `CORELINE_PROVIDER_SMOKE_TARGETS=compatible`
  - 필요 시 `CORELINE_PROVIDER_SMOKE_TARGETS=anthropic,openai,gemini`

### Nightly-safe
- 목적: 스케줄 기반으로 cloud smoke를 다시 확인
- 키가 없으면 skip하고 실패로 처리하지 않는다
- 추천 실행:
  - `bun run smoke:provider:nightly-safe`

## GitHub Actions 기대 동작

- push / pull_request: CI-safe만 실행
- workflow_dispatch: manual smoke 실행
- schedule: nightly-safe 실행

## 결과 기록 규칙

- 실행 날짜를 함께 적는다.
- local smoke는 PASS / BLOCKED를 분리해서 적는다.
- cloud smoke는 키가 없으면 BLOCKED로 적는다.
- 하니스 범위 밖 provider는 OUT-OF-SCOPE로 적는다.

## 2026-04-18 현재 기준선

- local compatible smoke
  - `qwen2.5-coder:7b` ✅
  - `gemma4:e2b` ✅
- cloud provider smoke
  - **BLOCKED**
  - 이유: 이 환경에 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`가 없음
