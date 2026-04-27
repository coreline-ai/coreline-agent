# Internal Hook Engine

`coreline-agent` has two hook concepts:

1. **clideck status hooks** under `/hook/coreline/*`
   - HTTP endpoints used by local dashboards or wrappers.
   - They update the agent status snapshot.
2. **Internal Hook Engine** under `src/hooks/*`
   - In-memory runtime for internal events.
   - It does not expose public registration APIs.
   - It does not persist hook config to `hooks.yml` yet.

## Supported events

- `StatusChange`
- `PreTool`
- `PostTool`
- `SessionStart`
- `SessionEnd`

## Supported hook types

- `function`
- `http`
- `command` — internal opt-in only, disabled by default

Public command hook registration and `hooks.yml` persistence remain intentionally excluded. The internal command-hook runner is available only when the in-memory engine is created with explicit opt-in, and it is permission-gated before execution.

## Execution flow

```text
event
  → matcher / if filter
  → matching hooks execute
  → HookResult[] collected
  → blocking result may stop or annotate tool execution, depending on event
```

## Blocking policy

Only explicit `blocking: true` blocks tool execution before the tool has run.

Hook failures are fail-open:

- timeout
- thrown error
- non-2xx HTTP response
- invalid HTTP response payload

Those failures are collected as `HookResult.error` and must not break status updates or the agent loop.

For `PostTool`, the tool has already executed. A blocking `PostTool` result does not roll back the tool result; it is appended to the formatted tool output as a hook blocking annotation so the next model continuation can see it.

## Command hook safety

Command hooks are **disabled by default**. When enabled internally, they use a constrained safe runner:

- command is checked through the Bash permission classifier before execution
- `ask` decisions are not executed in non-interactive mode
- `cwd` must stay inside the execution context cwd
- environment is allowlisted and credential-like keys are stripped
- stdout/stderr are truncated
- timeout, non-zero exit, abort, and runner errors are fail-open `HookResult.error`
- command output may return a small JSON payload with `blocking`, `message`, and `metadata`

## HTTP hook safety

HTTP hooks are localhost-only by default:

- `localhost`
- `127.0.0.1`
- `::1`

External hosts require an explicit allowlist. Ambient credentials are not forwarded.

## PreTool order

```text
permission deny → block immediately, hook not run
permission ask → user approval required before hook
PreTool hook blocking → block tool execution
all clear → execute tool
```

## PostTool order

```text
tool execution success/error
  → PostTool hook receives toolName, input, result, isError, metadata
  → hook failures are collected fail-open
  → blocking PostTool annotates the formatted tool result, without rollback
```
