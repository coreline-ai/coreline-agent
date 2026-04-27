# coreline-agent Docs Index

> Last synced: 2026-04-24

이 디렉토리는 사용자 문서, 운영 문서, smoke 기준, archived 구현 계획을 함께 보관한다.
현재 구현 여부를 판단할 때는 이 index보다 `docs/implementation-status.md`를 먼저 본다.

## Source of truth order

1. `src/**` + `tests/**` — 실제 구현과 검증
2. `dev-plan/implement_*.md` — 작업 단위별 완료 기록
3. `docs/implementation-status.md` — 현재 기준선/후속/archived 문서 판정
4. `README.md` — 사용자 사용법
5. 기타 `docs/*.md` — 영역별 상세 설명

## Current status

| 문서 | 용도 |
|------|------|
| `implementation-status.md` | 현재 구현 기준, archived plan 상태, 의도적 후속 항목 |
| `smoke.md` | smoke test 표준과 현재 선택 범위 |
| `single-agent-reliability.md` | reliability layer와 verification 기준 |
| `hook-engine.md` | 내부 Hook Engine 동작과 안전 정책 |
| `proxy-operations.md` | proxy 실행/운영 예시 |
| `clideck-integration.md` | clideck preset/status 연동 가이드 |
| `mcp-ops.md` | MCP bridge/resource 설정/운영 |
| `memory-system.md` | memory/AGENT.md 동작과 secret scanner 정책 |
| `provider-smoke-checklist.md` | provider smoke 수동 점검 |
| `provider-smoke-ci.md` | provider smoke CI 기준 |
| `cloud-oauth-providers.md` | OAuth provider 설정 |

## Archived plans

아래 문서는 historical plan이다. 현재 active TODO로 계산하지 않는다.

| 문서 | 현재 기준 |
|------|-----------|
| `impl-plan-coding-agent.md` | 초기 CLI/TUI 설계 기록 |
| `impl-plan-intelligence-accumulation.md` | 초기 memory/AGENT.md 설계 기록 |
| `impl-plan-bugfix-hardening.md` | 초기 bugfix/hardening 리뷰 기록 |

## Follow-up rule

후속 구현이 필요하면 기존 archived 문서를 수정하지 말고 새 `dev-plan/implement_YYYYMMDD_HHMMSS.md`를 만든다.
