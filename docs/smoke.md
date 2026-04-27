# Smoke Test Standard

이 문서는 실제 사용에 가까운 smoke 검증을 표준화하되, 기본 테스트에서 외부 LLM/API를 호출하지 않도록 고정한다.

## 기본 원칙

- 기본 smoke는 mock-first로 실행한다.
- cloud LLM/API 호출은 명시적 opt-in 환경변수가 있을 때만 허용한다.
- 수동 PTY/TUI 체감 QA는 자동 테스트와 분리해 기록한다.

## 현재 선택 범위

Phase 8의 첫 적용 범위는 `proxy` smoke다.

```bash
bun run smoke:proxy
```

검증 대상:

- `GET /health`
- `GET /v2/status`
- `GET /v2/capabilities`
- `POST /hook/coreline/start`
- `POST /hook/coreline/idle`
- `POST /hook/coreline/stop`

## 후속 범위

아래 항목은 이번 proxy smoke 완료 기준에는 포함하지 않고 후속 smoke로 남긴다.

- TUI render/helper smoke
- autopilot mock-provider happy path / blocked path smoke
- provider real smoke

provider real smoke는 기존 provider smoke script처럼 명시적 opt-in으로만 실행한다.
