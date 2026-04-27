# clideck integration

`coreline-agent` can be managed by clideck as a local CLI agent without moving the core runtime into clideck.
The first integration surface is intentionally small:

- `~/.coreline-agent/status.json` for file-based status polling
- `GET /v2/status` from `coreline-agent --proxy` or `coreline-agent-proxy`
- normal `--resume` support for continuing sessions

## Recommended preset

Add a preset similar to this to clideck's `agent-presets.json` or a local custom preset file:

```json
{
  "presetId": "coreline-agent",
  "name": "Coreline Agent",
  "icon": "⚡",
  "command": "coreline-agent",
  "isAgent": true,
  "canResume": true,
  "resumeCommand": "coreline-agent --resume {{sessionId}}",
  "sessionIdPattern": "Session:\\s+([0-9a-f-]{8,})",
  "outputMarker": "coreline",
  "statusUrl": "http://127.0.0.1:4317/v2/status",
  "hooks": {
    "start": "http://127.0.0.1:4317/hook/coreline/start",
    "stop": "http://127.0.0.1:4317/hook/coreline/stop",
    "idle": "http://127.0.0.1:4317/hook/coreline/idle"
  }
}
```

For proxy-first workflows, run the proxy separately:

```bash
coreline-agent-proxy --port 4317 --with-cli-fallback
```

Then launch agent sessions with:

```bash
coreline-agent --provider local-qwen
coreline-agent --autopilot -p "finish the current repo checks and stop when blocked or complete"
```

## Status endpoint

`GET /v2/status` returns:

```json
{
  "type": "agent_status",
  "available": true,
  "status": {
    "status": "running",
    "mode": "autopilot",
    "sessionId": "...",
    "provider": "local-qwen",
    "model": "qwen2.5-coder:7b",
    "lastActivity": "2026-04-19T...Z",
    "pid": 12345,
    "startedAt": "2026-04-19T...Z",
    "uptimeMs": 12000,
    "message": "running one-shot prompt"
  },
  "hooks": {
    "start": "/hook/coreline/start",
    "stop": "/hook/coreline/stop",
    "idle": "/hook/coreline/idle"
  }
}
```

The `hooks` block is discoverability metadata for clideck-side integrations.
The hook endpoints are implemented locally and update the shared status snapshot:

- `POST /hook/coreline/start` → status becomes `running`
- `POST /hook/coreline/stop` → status becomes `exited` or `aborted`
- `POST /hook/coreline/idle` → status becomes `idle`

Each hook accepts optional JSON metadata such as `sessionId`, `provider`, `model`, `mode`, `cwd`, `turn`, and `message`. When present, the proxy writes those fields into `status.json` so dashboards can reflect the latest state.

## Status file

The same status snapshot is written to:

```text
~/.coreline-agent/status.json
```

Unlike a transient lock file, this file is kept after shutdown with `status: "exited"` so dashboards can still show the last known session and resume hint.

## Status values

Current values:

- `idle`
- `planning`
- `running`
- `blocked`
- `needs_user`
- `completed`
- `failed`
- `aborted`
- `exited`

Mode values:

- `chat`
- `plan`
- `goal`
- `autopilot`
- `proxy`

## Environment notes

Forward these env vars through clideck when needed:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `PROXY_PORT`
- `PROXY_AUTH_TOKEN`
- `CORELINE_NO_AUTO_SUMMARY`

## Current limits

- No clideck code changes are required for this document.
- Browser/xterm UI embedding is out of scope.
- OTLP telemetry compatibility is a later option, not required for v1.
