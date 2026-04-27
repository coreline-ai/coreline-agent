# Proxy Operations

This document describes the operational contract for `coreline-agent-proxy`.

## Endpoints

- `GET /health`
- `GET /v1/providers`
- `GET /v2/capabilities`
- `POST /v2/batch`
- `POST /anthropic/v1/messages`
- `POST /openai/v1/chat/completions`
- `POST /openai/v1/responses`
- Aliases under `/v1/*`

## Request tracing

- The proxy accepts `X-Request-Id`.
- If not provided, the proxy generates one.
- Every response includes `X-Request-Id`.
- Batch items get derived ids such as `<request-id>.b1`.

## Authentication

- If `PROXY_AUTH_TOKEN` or `--auth-token` is set, every request must include:
  - `Authorization: Bearer <token>` or
  - `x-api-key: <token>`
- Failed auth returns:
  - `401`
  - JSON error body with `requestId`

## Batch policy

- Default limits:
  - max items: `8`
  - max concurrency: `4`
  - per-item timeout: `30000ms`
- The CLI exposes overrides:
  - `--max-batch-items`
  - `--max-batch-concurrency`
  - `--batch-timeout-ms`
- A batch request above the item limit fails with:
  - `413 batch_limit_exceeded`
- `stream=true` inside batch items is rejected.
- batch envelope 자체는 `200 batch_response`일 수 있고, 개별 item 결과가 `400 unsupported_batch_streaming`이 된다.

## Human input mode

- `human_input_mode` / `humanInputMode` / `humanInput`는 hosted interactive tool 요청에 대해 명시적으로 게이트된다.
- `return` mode:
  - HTTP `409`
  - `human_input_required` payload 반환
  - 호출자가 사용자 입력을 직접 처리하도록 넘긴다.
- `forbid` 또는 미설정:
  - HTTP `400`
  - interactive hosted tool 요청을 명시적으로 거부한다.
- 이 정책은 자동 대화/승인 프록시를 제공하지 않고, 호출자가 human-in-the-loop 경계를 명시적으로 처리하게 만드는 운영 계약이다.

## Hosted tools

- Hosted tools such as `web_search` and `code_execution` are passed through when the selected provider supports them.
- If the selected provider does not support a hosted tool, the proxy returns:
  - `400 unsupported_hosted_tool`
- This is surfaced in both JSON responses and streaming error events.

### Hosted tools support matrix

| provider type | 상태 | 비고 |
|---|---|---|
| `anthropic` | passthrough | `web_search_20250305`, `code_execution_20250825` |
| `codex-backend` | passthrough | `web_search`, `code_interpreter` |
| `openai` | unsupported | 명시적 에러 |
| `openai-compatible` | unsupported | 명시적 에러 |
| `gemini` / `gemini-code-assist` | unsupported | 명시적 에러 |

## Example

```bash
curl -H 'Authorization: Bearer secret-token' \
  -H 'X-Request-Id: demo-123' \
  http://127.0.0.1:4317/v2/capabilities
```

```bash
curl -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "requests": [
      { "method": "GET", "path": "/health" },
      { "method": "GET", "path": "/v1/providers" }
    ]
  }' \
  http://127.0.0.1:4317/v2/batch
```

## 2026-04-18 live smoke

- `GET /health` ✅
- `GET /v2/capabilities` ✅
- `POST /v2/batch` ✅
- `POST /openai/v1/responses` + hosted tool on local `openai-compatible` provider
  - 결과: `400 unsupported_hosted_tool` ✅
- `POST /openai/v1/chat/completions` + interactive hosted tool + `human_input_mode: return`
  - 결과: `409 human_input_required` ✅
- `POST /openai/v1/chat/completions` + interactive hosted tool + `human_input_mode: forbid`
  - 결과: `400 unsupported_human_input_mode` ✅
- `POST /v2/batch` item with `stream=true`
  - 결과: batch envelope `200`, item result `400 unsupported_batch_streaming` ✅
