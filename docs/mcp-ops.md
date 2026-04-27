# MCP 운영 메모

이 문서는 `src/mcp/*`에서 제공하는 운영용 helper와 기본 정책을 짧게 정리한다.

## 설정 로드 상태

`loadMcpConfigWithStatus(filePath)`는 다음 상태를 반환한다.

- `loaded`: 파일을 정상 로드
- `missing`: 파일이 없음
- `invalid`: 파일은 있으나 파싱/검증 실패

반환값에는 `config`와 함께 `error`(invalid일 때)가 포함된다.

## 서버 선택 규칙

`resolveMcpServerSelection(config, requestedServerName?)`는 다음을 보장한다.

- 명시된 서버명이 있으면 우선 선택
- 명시된 서버가 비활성화면 `disabled`
- `defaultServer`가 활성화되어 있으면 기본 선택
- `defaultServer`가 없거나 비활성화면 첫 번째 활성 서버로 fallback
- 활성 서버가 없으면 `none`

## 연결 상태 스냅샷

`McpConnectionManager.getStatusSnapshot()`은 다음 정보를 제공한다.

- 현재 default server
- 서버 선택 상태와 사유
- 서버별 연결 상태
- 최근 에러 메시지
- tool/resource 개수
- 마지막 initialize / tool refresh / resource refresh 시각
- stdio transport라면 command / args / stderr tail

## MCP Resources

MCP 서버가 resources capability를 제공하면 다음 API와 내장 도구를 사용할 수 있다.

- `McpClientSession.listResources(refresh?)`
- `McpClientSession.readResource(uri)`
- `McpConnectionManager.listResources(server?, refresh?)`
- `McpConnectionManager.readResource(serverName, uri)`
- `ListMcpResources`
- `ReadMcpResource`

`ReadMcpResource`는 text resource를 직접 반환하고, blob/base64 resource는 project/session scoped `tool-results/` 디렉토리에 저장한 뒤 경로와 preview만 모델 컨텍스트로 반환한다.

## MCP 도구 권한 정책

MCP 도구는 이름 기반 휴리스틱을 사용한다.

- `server:listPages`, `server:readDoc` 같은 이름은 read-only로 취급
- `server:updatePage`, `server:deleteItem` 같은 이름은 확인이 필요한 것으로 취급
- bridge 쪽에서도 동일 휴리스틱을 사용해 concurrency/read-only 판단을 보조한다
- `ListMcpResources`, `ReadMcpResource`는 read-only/concurrency-safe 도구로 기본 허용된다

명시적 permissions rule은 항상 우선한다.

## 2026-04-18 smoke 메모

- `~/.coreline-agent/mcp.yml`: 없음
  - 따라서 사용자 환경 기준의 기본 MCP startup smoke는 **BLOCKED**
- 대신 로컬 real stdio mock server smoke는 확인됨
  - `bun test tests/mcp-connection.test.ts` ✅
  - real stdio spawn + initialize + tools/list + tools/call 경로 확인
  - resource API는 `tests/mcp-resources.test.ts` mock transport에서 list/read/text/blob 저장 경로 확인
