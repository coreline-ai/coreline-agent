# Cloud LLM Connection via OAuth (API Key-Free)

coreline-agent는 Claude Code / Codex CLI / Gemini CLI가 이미 발급한 OAuth 토큰을 재사용하여 **API 키 없이** 클라우드 LLM을 호출할 수 있습니다.

---

## 지원 프로바이더

| 프로바이더 타입 | 인증 소스 | 필요 조건 | API 키 | 비용 |
|-----------------|-----------|-----------|--------|------|
| `anthropic` + `oauthToken` | `CLAUDE_CODE_OAUTH_TOKEN` 환경변수 | Claude Code 로그인 | 불필요 | Claude Pro/Max 구독 |
| `codex-backend` | `~/.codex/auth.json` 또는 `CODEX_AUTH_PATH` | Codex CLI 로그인 (ChatGPT Plus) | 불필요 | ChatGPT Plus 구독 |
| `gemini-code-assist` | `~/.gemini/oauth_creds.json` | Gemini CLI 로그인 (GCP 계정) | 불필요 | GCP 무료/유료 티어 |

---

## providers.yml 예시

### 예시 1: 모든 프로바이더 OAuth 기반

```yaml
# ~/.coreline-agent/providers.yml

default: claude-oauth

providers:
  # Claude — Claude Code OAuth 토큰
  claude-oauth:
    type: anthropic
    oauthToken: ${CLAUDE_CODE_OAUTH_TOKEN}
    model: claude-sonnet-4-20250514
    maxContextTokens: 200000

  # ChatGPT / Codex — Codex CLI OAuth
  chatgpt:
    type: codex-backend
    model: gpt-5
    maxContextTokens: 200000
    # oauthFile 생략 시 ~/.codex/auth.json 자동 사용

  # Gemini — Gemini CLI OAuth
  gemini:
    type: gemini-code-assist
    model: gemini-2.5-pro
    maxContextTokens: 1000000
    # oauthFile 생략 시 ~/.gemini/oauth_creds.json 자동 사용
    # geminiProject: my-gcp-project-id  # 선택 사항

  # 로컬 LLM (Ollama)
  local:
    type: openai-compatible
    baseUrl: http://localhost:11434/v1
    model: qwen2.5-coder:7b
    maxContextTokens: 32000
```

### 예시 2: Codex 커스텀 경로

```yaml
providers:
  my-chatgpt:
    type: codex-backend
    model: gpt-5-codex
    oauthFile: /custom/path/to/auth.json
```

`codex-backend` 인증 파일 탐색 우선순위는 `oauthFile` → `CODEX_AUTH_PATH` → `~/.codex/auth.json` → legacy proxy token path입니다. `CODEX_CONFIG_PATH` 또는 `~/.codex/config.toml`에 있는 `model`, `model_reasoning_effort`는 provider config에 모델이 없을 때 fallback/metadata로 사용됩니다.

Codex 응답의 quota/rate-limit 헤더가 존재하면 안전한 metadata로 캡처되어 provider metadata, status snapshot, TUI status bar에서 선택적으로 표시될 수 있습니다. OAuth token, API key, prompt 본문은 metadata에 포함하지 않습니다.

---

## 설정 방법

### 1. Claude OAuth (가장 간단)

Claude Code를 이미 사용 중이면:

```bash
# Claude Code에서 OAuth 토큰을 export하면 됨
# (Claude Code 설정 참고)
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oauth-..."

# providers.yml에 등록
cat >> ~/.coreline-agent/providers.yml <<'EOF'
providers:
  claude:
    type: anthropic
    oauthToken: ${CLAUDE_CODE_OAUTH_TOKEN}
    model: claude-sonnet-4-20250514
EOF
```

### 2. Codex Backend (ChatGPT 구독자용)

```bash
# Codex CLI 설치 & 로그인
brew install codex  # 또는 공식 가이드 참고
codex auth login    # 브라우저에서 ChatGPT 로그인

# 토큰 파일 확인
ls ~/.codex/auth.json

# 선택: 커스텀 auth/config 경로
export CODEX_AUTH_PATH=/custom/path/to/auth.json
export CODEX_CONFIG_PATH=/custom/path/to/config.toml

# providers.yml에 등록
cat >> ~/.coreline-agent/providers.yml <<'EOF'
providers:
  chatgpt:
    type: codex-backend
    model: gpt-5
EOF
```

**지원 모델**: `gpt-5`, `gpt-5-codex`, `gpt-4o` (ChatGPT 구독에서 사용 가능한 모델)

### 3. Gemini Code Assist

```bash
# Gemini CLI 설치 & 로그인
npm install -g @google/gemini-cli  # 또는 공식 가이드
gemini auth login   # 브라우저에서 Google 로그인

# 토큰 파일 확인
ls ~/.gemini/oauth_creds.json

# providers.yml에 등록
cat >> ~/.coreline-agent/providers.yml <<'EOF'
providers:
  gemini:
    type: gemini-code-assist
    model: gemini-2.5-pro
EOF
```

**GCP 프로젝트**: 자동으로 감지됩니다. 수동 지정은 `geminiProject` 필드 사용.

---

## 토큰 새로고침

세 프로바이더 모두 **자동 토큰 갱신**을 지원합니다:

- 만료 5분 전부터 자동으로 refresh token 사용
- 갱신된 토큰은 원본 파일에 자동 저장
- 사용자가 개입할 필요 없음

---

## 동작 확인

```bash
# Claude OAuth 테스트
bun run src/index.ts --provider claude -p "hello from claude oauth"

# ChatGPT 테스트
bun run src/index.ts --provider chatgpt -p "hello from gpt-5"

# Gemini 테스트
bun run src/index.ts --provider gemini -p "hello from gemini"
```

## 주의사항

- **Claude**: Anthropic 공식 지원은 Claude Code의 OAuth 플로우만 허용됨. 다른 용도 사용 시 TOS 확인 필요.
- **Codex**: `https://chatgpt.com/backend-api/codex/responses` 는 **비공개 API**. ChatGPT 구독 약관 범위 내에서 사용.
- **Gemini**: GCP 프로젝트가 `cloudaicompanion.googleapis.com` 서비스를 활성화해야 함. 처음 사용 시 자동 프로비저닝.

## 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `[codex-backend] No Codex OAuth tokens found` | `~/.codex/auth.json` 없음 | `codex auth login` 실행 |
| `[gemini-code-assist] No Gemini OAuth credentials` | `~/.gemini/oauth_creds.json` 없음 | `gemini auth login` 실행 |
| `401 Unauthorized` | 토큰 만료 + refresh 실패 | 해당 CLI로 재로그인 |
| `Could not discover GCP project` | Gemini: 프로젝트 미설정 | `providers.yml`에 `geminiProject` 명시 |
