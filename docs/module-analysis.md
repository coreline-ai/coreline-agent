# Claude Code Package — Module Extraction Analysis

> 분석일: 2026-04-09
> 대상: `/Users/hwanchoi/projects/claude-code/package/sourcemap-extracted/src/`
> 총 소스 규모: **512,785 LOC** (TypeScript/TSX)

---

## 1. 소스 구조 개요

### 1.1 최상위 디렉토리별 규모

| 디렉토리 | LOC | 비중 | 설명 |
|----------|-----|------|------|
| `utils/` | 180,498 | 35.2% | 유틸리티 (bash 파서, 권한, 플러그인 등) |
| `services/` | 53,682 | 10.5% | 비즈니스 서비스 (API, MCP, OAuth 등) |
| `tools/` | 50,828 | 9.9% | 도구 구현체 (Bash, Agent, File 등) |
| `hooks/` | 19,226 | 3.8% | 이벤트 훅 시스템 |
| `components/` | — | — | UI 컴포넌트 (Ink/React) |
| `commands/` | — | — | 슬래시 커맨드 (~90개) |
| `skills/` | 4,066 | 0.8% | 스킬 시스템 |
| `tasks/` | 3,286 | 0.6% | 태스크 관리 |
| `remote/` | 1,127 | 0.2% | 원격 에이전트 |
| `coordinator/` | 369 | 0.1% | 코디네이터 모드 |

### 1.2 utils/ 하위 모듈별 규모

| 하위 디렉토리 | LOC | 설명 |
|---------------|-----|------|
| `plugins/` | 20,521 | 플러그인 로더, 마켓플레이스 |
| `bash/` | 12,306 | Bash AST 파서, 셸 명령 분석 |
| `permissions/` | 9,409 | 권한 분류기, 규칙 파서, 경로 검증 |
| `swarm/` | 7,548 | 멀티 에이전트 협업 |
| `settings/` | 4,562 | 설정 관리 |
| `telemetry/` | 4,044 | 텔레메트리 수집 |
| `hooks/` | 3,721 | 훅 유틸리티 |
| `shell/` | 3,069 | 셸 커맨드 검증 |
| `nativeInstaller/` | 3,018 | 네이티브 설치 |
| `model/` | 2,710 | 모델 관련 |
| `claudeInChrome/` | 2,337 | Chrome 확장 |
| `powershell/` | 2,305 | PowerShell 유틸 |
| `computerUse/` | 2,161 | 컴퓨터 사용 |
| `processUserInput/` | 1,765 | 사용자 입력 처리 |
| `deepLink/` | 1,388 | 딥링크 |
| `task/` | 1,223 | 태스크 유틸 |
| `git/` | 1,075 | Git 유틸 |

### 1.3 utils/ 루트 대형 파일 (top 10)

| 파일 | LOC | 설명 |
|------|-----|------|
| `messages.ts` | 5,511 | 메시지 처리 |
| `sessionStorage.ts` | 5,132 | 세션 직렬화/역직렬화 |
| `hooks.ts` | 5,022 | 훅 시스템 |
| `attachments.ts` | 3,997 | 첨부파일 처리 |
| `auth.ts` | 2,002 | 인증 유틸 |
| `config.ts` | 1,817 | 설정 관리 |
| `Cursor.ts` | 1,530 | 커서 관리 |
| `worktree.ts` | 1,519 | Git 워크트리 |
| `ide.ts` | 1,494 | IDE 통합 |
| `claudemd.ts` | 1,479 | CLAUDE.md 파싱 |

### 1.4 services/ 하위 모듈별 규모

| 하위 디렉토리 | LOC | 설명 |
|---------------|-----|------|
| `mcp/` | 12,310 | MCP 프로토콜 클라이언트 (23개 파일) |
| `api/` | 10,479 | Claude API 클라이언트 (20개 파일) |
| `analytics/` | 4,040 | 분석·추적 |
| `compact/` | 3,960 | 대화 컨텍스트 압축 |
| `tools/` | 3,113 | 도구 서비스 |
| `lsp/` | 2,460 | LSP 서버 |
| `teamMemorySync/` | 2,167 | 팀 메모리 동기화 |
| `plugins/` | 1,616 | 플러그인 서비스 |
| `PromptSuggestion/` | 1,514 | 프롬프트 제안 |
| `oauth/` | 1,051 | OAuth 클라이언트 (5개 파일) |
| `SessionMemory/` | 1,026 | 세션 메모리 |

### 1.5 tools/ 주요 도구별 규모

| 도구 | LOC | 설명 |
|------|-----|------|
| `BashTool/` | 12,411 | Bash 실행 + 보안 검증 |
| `PowerShellTool/` | 8,959 | PowerShell 실행 + 경로 검증 |
| `AgentTool/` | 6,782 | 서브에이전트 생성·관리 |
| `LSPTool/` | 2,005 | LSP 도구 |
| `FileEditTool/` | 1,812 | 파일 편집 |
| `FileReadTool/` | 1,602 | 파일 읽기 |
| `SkillTool/` | 1,477 | 스킬 실행 |
| `WebFetchTool/` | 1,131 | 웹 페치 |
| `MCPTool/` | 1,086 | MCP 도구 |
| `SendMessageTool/` | 997 | 메시지 전송 |

---

## 2. 모듈화 제안

### 2.1 Tier 1 — 즉시 추출 가능 (외부 의존도 낮음)

| # | 모듈명 | 현재 위치 | LOC | 추출 근거 |
|---|--------|-----------|-----|-----------|
| 1 | **bash-parser** | `utils/bash/` | 12,306 | AST 파서 + 셸 명령 분석기. `bashParser.ts`(4,436), `ast.ts`(2,679) 등 독립적 파싱 로직. 외부 프로젝트에서도 재사용 가능한 순수 파서. 외부 런타임 의존 없음 |
| 2 | **permission-engine** | `utils/permissions/` | 9,409 | 권한 분류기(`bashClassifier`, `yoloClassifier`), 규칙 파서, 경로 검증. 보안 레이어를 독립 모듈화하면 다른 에이전트에도 적용 가능. 테스트·감사 용이성 향상 |
| 3 | **oauth-client** | `services/oauth/` | 1,051 | PKCE 플로우, auth-code 리스너, crypto, 프로필 조회. 이미 5개 파일로 깔끔하게 격리됨 — `index.ts`로 패키지 엔트리만 정의하면 즉시 독립 가능 |
| 4 | **mcp-client** | `services/mcp/` | 12,310 | MCP 프로토콜 클라이언트, 인증, 연결 관리, 채널 허용목록. 23개 파일이 이미 하나의 관심사(MCP 프로토콜)에 집중 |
| 5 | **token-estimator** | `services/tokenEstimation.ts` | 495 | 토큰 수 추정 로직. 단일 파일, 범용적 유틸리티. 어떤 LLM 앱에서든 재사용 가능 |

### 2.2 Tier 2 — 내부 리팩토링 후 추출 가능

| # | 모듈명 | 현재 위치 | LOC | 추출 근거 |
|---|--------|-----------|-----|-----------|
| 6 | **shell-security** | `tools/BashTool/` | 12,411 | `bashPermissions.ts`(2,621) + `bashSecurity.ts`(2,592) + `readOnlyValidation.ts`(1,990). 셸 명령 보안 검증 레이어. bash-parser와 합치거나 독립 보안 패키지로 |
| 7 | **plugin-system** | `utils/plugins/` + `services/plugins/` | 22,137 | `pluginLoader.ts`(3,302) + `marketplaceManager.ts`(2,643). 플러그인 로딩·마켓플레이스·DXT 파싱이 하나의 독립 시스템 |
| 8 | **compact-engine** | `services/compact/` | 3,960 | 대화 컨텍스트 압축 서비스. 긴 대화를 요약하는 독립 알고리즘 — 다른 LLM 앱에서도 유용 |
| 9 | **voice-pipeline** | `services/voice*.ts` + `src/voice/` | ~2,000+ | STT 스트리밍, 키워드 감지, 음성 입력 파이프라인. I/O 바운더리가 명확하여 인터페이스 분리 가능 |
| 10 | **session-storage** | `utils/sessionStorage.ts` | 5,132 | 세션 히스토리 직렬화/역직렬화. 파일 기반 영속화 로직이 한 파일에 집중 |

### 2.3 Tier 3 — 장기 구조 개선 (고 영향, 고 난이도)

| # | 모듈명 | 현재 위치 | LOC | 추출 근거 |
|---|--------|-----------|-----|-----------|
| 11 | **api-client** | `services/api/` | 10,479 | `claude.ts`(3,418) 중심. 재시도, 에러 핸들링, 사용량 추적이 하나의 API 래퍼. 현재 Claude 전용이지만 provider-agnostic 인터페이스로 추상화 가능 |
| 12 | **swarm-coordinator** | `utils/swarm/` | 7,548 | 멀티 에이전트 협업 로직. 성장 가능성 높지만 현재 내부 결합도도 높음 |
| 13 | **main.tsx 분해** | `main.tsx` | 4,683 | 앱 진입점 4,683줄. 초기화·라우팅·상태 세팅을 별도 bootstrap 모듈로 분리 필요 |

---

## 3. 우선순위 로드맵

```
Phase 1 (즉시 착수)
  oauth-client → bash-parser → permission-engine

Phase 2 (중기)
  mcp-client → plugin-system → compact-engine

Phase 3 (장기)
  api-client 추상화 → main.tsx 분해 → swarm-coordinator
```

### ROI 순위 Top 5

| 순위 | 모듈 | 비용 | 재사용성 | 이유 |
|------|------|------|----------|------|
| 1 | **oauth-client** | 낮음 | 높음 | 5개 파일로 이미 격리, 즉시 패키지화 가능 |
| 2 | **bash-parser** | 낮음 | 매우 높음 | 순수 파싱 로직, 외부 의존 0, 범용 CLI 에이전트에 적용 |
| 3 | **permission-engine** | 중간 | 높음 | 보안 핵심 모듈 독립 → 테스트·감사·재사용 개선 |
| 4 | **token-estimator** | 매우 낮음 | 높음 | 단일 파일, 5분 작업 |
| 5 | **mcp-client** | 중간 | 높음 | MCP 프로토콜 범용 클라이언트로 가치 높음 |

---

## 4. 참고: 주요 대형 파일 (2,500+ LOC)

| 파일 경로 | LOC |
|-----------|-----|
| `cli/print.ts` | 5,594 |
| `utils/messages.ts` | 5,511 |
| `utils/sessionStorage.ts` | 5,132 |
| `utils/hooks.ts` | 5,022 |
| `screens/REPL.tsx` | 5,005 |
| `main.tsx` | 4,683 |
| `utils/bash/bashParser.ts` | 4,436 |
| `utils/attachments.ts` | 3,997 |
| `services/api/claude.ts` | 3,418 |
| `services/mcp/client.ts` | 3,348 |
| `utils/plugins/pluginLoader.ts` | 3,302 |
| `commands/insights.ts` | 3,200 |
| `bridge/bridgeMain.ts` | 2,999 |
| `utils/bash/ast.ts` | 2,679 |
| `utils/plugins/marketplaceManager.ts` | 2,643 |
| `tools/BashTool/bashPermissions.ts` | 2,621 |
| `tools/BashTool/bashSecurity.ts` | 2,592 |
| `native-ts/yoga-layout/index.ts` | 2,578 |
| `services/mcp/auth.ts` | 2,465 |
