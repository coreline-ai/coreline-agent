<div align="center">

<img width="2752" height="1536" alt="unnamed (1)" src="https://github.com/user-attachments/assets/75eed955-5543-43da-8427-444a3b0605e9" />

<img width="0" height="0" alt="coreline-agent 멀티 코딩 에이전트" src="https://github.com/user-attachments/assets/8e7ba333-a62d-47a7-87e8-4cbe2eded4a4" />
<img width="0" height="0" alt="멀티 LLM 코딩 에이전트 기능" src="https://github.com/user-attachments/assets/db7e5c39-a1e0-4b62-acf9-d5c5dd05c7b1" />
<img width="0" height="0" alt="지능형 코딩 파트너 기능 안내" src="https://github.com/user-attachments/assets/d48f2ac1-b9e2-468d-8791-f4718ee80a88" />

# ⚡ coreline-agent

**Multi-provider coding agent TUI — connect Claude, OpenAI, Gemini, and local LLMs via a single interface**

[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.1-black?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript%205.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1504%20pass-brightgreen)](#-testing)
[![Providers](https://img.shields.io/badge/providers-9%20types-blue)](#-providers)

<br/>

[Quick Start](#-quick-start) · [Providers](#-providers) · [Built-in Skills](#-built-in-skills) · [Proxy Server](#-proxy-server) · [Agent Delegation](#-agent-delegation) · [Plan & Goal Mode](#-plan--goal-mode) · [Reliability](#single-agent-reliability-layer) · [Memory](#-memory-system) · [MCP](#-mcp-tool-bridge) · [Testing](#-testing)

</div>

---

## 📖 Overview

coreline-agent is a terminal-based coding agent that connects to **multiple LLM providers** through a unified interface. It runs as an interactive TUI, a single-shot CLI, or a local proxy server, with built-in tools for file manipulation, code search, shell execution, project memory, sub-agent delegation, planning, reliability verification, and advisory built-in skills.

```
┌─────────────────────────────────────────────────────────┐
│  coreline-agent TUI                                     │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 🤖 assistant                                        ││
│  │ I found 3 TypeScript files that need updating...    ││
│  │ [FileRead] src/index.ts  ✓                          ││
│  │ [FileEdit] src/utils.ts  ✓                          ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │ > your prompt here...                      [Enter]  ││
│  └─────────────────────────────────────────────────────┘│
│  claude · claude-sonnet-4-5 · 1.2k tokens · turn 3     │
│  mode: default · proxy: http://127.0.0.1:4317 (8)      │
└─────────────────────────────────────────────────────────┘
```

### Highlights

- 🔌 **9 provider types** — Anthropic, OpenAI, Gemini, Codex backend, Gemini Code Assist, OpenAI-compatible (Ollama/vLLM), claude-cli, gemini-cli, codex-cli
- 🛠️ **12 core tools** — Bash, FileRead, FileWrite, FileEdit, Glob, Grep, MemoryRead, MemoryWrite, Agent, Git, TodoWrite, AskUserQuestion, plus MCP bridge/resource tools when configured
- 🧩 **Built-in skills** — root-agent advisory workflows for dev-plan, parallel development, investigation, and code review
- 🌐 **Local proxy server** — Anthropic / OpenAI / Responses API endpoints, v2 batch/capabilities/status, SSE status, dashboard shell, A2A discovery boundary
- 🧠 **Agent delegation** — Sub-agent spawning with depth-2 recursion, parallel execution, coordinator/pipeline handoff, TUI background task tracking, and background verification tasks
- 📋 **Plan + Goal + Autopilot** — Structured planning, deterministic verification, task-state execution, re-planning, resumable goal runs, and single-agent autopilot
- 🛡️ **Single-agent hardening** — file backup/undo, edit diffs, explicit test loop, Git tool, ToolCache, FileTransaction, watchdog, and cost budget warnings
- ✅ **Reliability layer** — CompletionJudge, redacted trace records, RecoveryCheckpoint, ResumeAdvice, and VerificationPack
- 💾 **Project memory** — AGENT.md / CLAUDE.md loading + persistent per-project memory with auto-summary and high-confidence secret scanning
- 🔗 **MCP integration** — stdio MCP server bridge with policy-gated tool loading plus `resources/list` / `resources/read`
- 📡 **Remote agent** — HTTP-based task dispatch to remote proxy instances

### Current Implementation Baseline

| Area | Current status |
|------|----------------|
| Test baseline | `1504 pass / 0 fail / 205 files` |
| Core agent | Agent loop, permission engine, PreTool/PostTool hooks, internal command-hook safe runner, sessions, transcript search/replay, project memory, `@file`, MCP bridge |
| Providers | 9 provider types including API, OAuth, OpenAI-compatible, and CLI-backed providers |
| Tools | 12 core tools including `Agent`, `Git`, `TodoWrite`, `AskUserQuestion`, plus MCP-bridged/resource tools |
| Proxy | Anthropic/OpenAI/Responses API, v2 status/batch/capabilities, hosted tool passthrough policy, A2A discovery boundary, dashboard/SSE status |
| Agent workflows | AgentTool depth-2, coordinator, pipeline handoff, Parallel Agent Runtime v1/v1.5 background tasks, workstream cards, worktree helper, remote scheduler, plan-execute, goal mode, autopilot |
| Reliability / hardening | CompletionJudge, trace, recovery advice, verification pack, backup/undo, diff preview, Bash/FS/File safety V2, ToolCache, FileTransaction, watchdog, cost/quota tracking |
| Operator UX | roles, prompt library, `/context`, `/macro parse`, `/scaffold`, `/set`, `/reset`, `/verify`, session export with parallel task evidence, built-in skills, status bar/runtime tweaks, opt-in auto verifier |
| Built-in skills | `dev-plan`, `parallel-dev`, `investigate`, `code-review` as advisory root-agent workflows |

The current implementation baseline and intentional follow-ups are tracked in [docs/implementation-status.md](docs/implementation-status.md). Older `docs/impl-plan-*.md` files are archived historical plans, not active TODO lists.

---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.1.0

### Install & Run

```bash
# Install dependencies
bun install

# Interactive TUI (auto-detects provider from env vars)
bun run dev

# Single-shot CLI
bun run dev -- -p "list TypeScript files in src/"

# With specific provider
bun run dev -- --provider claude --model claude-sonnet-4-5

# Start proxy server
bun run dev:proxy

# Run explicit test-loop helper
bun run dev -- --test-loop "bun test"

# Track session cost budget warnings
bun run dev -- --budget 1.00
bun run dev -- --budget 1.00 --budget-stop

# Export saved sessions for review / PR drafts
bun run dev -- --export-session latest --export-format md
bun run dev -- --export-session latest --export-format pr

# Abort one-shot chat if no progress is observed for N seconds
bun run dev -- -p "review src/" --watchdog-timeout 120

# Built-in skill controls
bun run dev -- --list-skills
bun run dev -- --show-skill dev-plan
bun run dev -- -p "코드 리뷰 해줘" --skill code-review --no-auto-skills

# Plan / goal / autopilot
bun run dev -- --plan-mode -p "review src and run tests"
bun run dev -- --goal-mode -p "ship the TypeScript fixes and verify"
bun run dev -- --autopilot -p "complete the task, verify, and stop when done"

# Smoke checks
bun run smoke
bun run smoke:proxy
bun run smoke:agent
```

### First-time Setup

Create `~/.coreline-agent/providers.yml`:

```yaml
default: claude
providers:
  claude:
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-20250514

  gpt:
    type: openai
    apiKey: ${OPENAI_API_KEY}
    model: gpt-4o

  gemini:
    type: gemini
    apiKey: ${GOOGLE_API_KEY}
    model: gemini-2.5-pro

  local:
    type: openai-compatible
    baseUrl: http://localhost:11434/v1
    model: qwen2.5-coder:7b
```

Or just set an env variable — the agent auto-detects:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
# or
export GOOGLE_API_KEY=...
```

---

## 🔌 Providers

| Type | Auth | Transport | Tool Calling | Streaming |
|------|------|-----------|:------------:|:---------:|
| `anthropic` | API key / OAuth | SDK | ✅ | ✅ |
| `openai` | API key | SDK | ✅ | ✅ |
| `gemini` | API key | SDK | ✅ | ✅ |
| `codex-backend` | OAuth (`~/.codex/auth.json`, `CODEX_AUTH_PATH`) | fetch | ✅ | ✅ |
| `gemini-code-assist` | OAuth (~/.gemini/oauth_creds.json) | fetch | ✅ | ✅ |
| `openai-compatible` | API key / none | fetch | ✅ | ✅ |
| `claude-cli` | Local binary | Bun.spawn | ❌ | ❌ |
| `gemini-cli` | Local binary | Bun.spawn | ❌ | ❌ |
| `codex-cli` | Local binary | Bun.spawn | ❌ | ❌ |

`codex-backend` reads Codex CLI-compatible OAuth tokens from `oauthFile`, `CODEX_AUTH_PATH`, `~/.codex/auth.json`, or the legacy proxy token path. It also reads `model` and `model_reasoning_effort` from `CODEX_CONFIG_PATH` / `~/.codex/config.toml` as fallback metadata when provider config does not specify a model.

Codex response quota/rate-limit headers are captured as optional safe metadata and can be surfaced through status snapshots and the TUI status bar. Token values and prompt bodies are never included in provider metadata.

### Provider Priority

```
CLI flag (--provider) > config.yml > providers.yml default > env variable fallback
```

---

## 🛠️ Built-in Tools

| Tool | Description | Permission |
|------|-------------|:----------:|
| `Bash` | Execute shell commands | 🟡 ask |
| `FileRead` | Read file contents | 🟢 allow |
| `FileWrite` | Create / overwrite files | 🟡 ask |
| `FileEdit` | Exact string replacement in files | 🟡 ask |
| `Glob` | Find files by pattern | 🟢 allow |
| `Grep` | Search file contents with regex | 🟢 allow |
| `MemoryRead` | Read project memory entries | 🟢 allow |
| `MemoryWrite` | Write project memory entries | 🟡 ask |
| `Agent` | Delegate sub-tasks to child agents | 🟢 allow* |
| `Git` | Structured git status/diff/log/show/apply/stage/commit | 🟢 allow / 🟡 ask |
| `TodoWrite` | Maintain the session task checklist | 🟢 allow |
| `AskUserQuestion` | Ask 1–3 structured multiple-choice questions in TUI | 🟢 allow |
| `ListMcpResources` | List MCP resources when MCP is configured | 🟢 allow |
| `ReadMcpResource` | Read MCP text/blob resources, storing blobs locally | 🟢 allow |
| `MCP:*` | MCP server bridged tools | 🟡 ask |

\* Write-capable Agent delegation requires explicit confirmation.

Tool hardening notes:

- `FileRead` and `Glob` can use `ToolCache` to reduce repeated I/O while respecting mtime/realpath invalidation.
- `FileRead` blocks infinite or interactive device paths such as `/dev/zero`, `/dev/random`, stdio fd aliases, and `/proc/*/fd/0..2`.
- `FileWrite`, `FileEdit`, and transaction rollback invalidate affected cache paths.
- `FileEdit` requires a prior full `FileRead`, rejects partial-read edits, and blocks stale writes when content changed since the last read.
- `FileEdit` preserves UTF-8/UTF-16LE BOMs, normalizes line endings for replacements, rejects no-op edits, and can match common curly/straight quote variants.
- `FileEdit` rejects null-byte/binary files and writes through a same-directory temp file before atomic rename.
- Write-capable file paths are guarded against protected project/config paths, symlink/realpath traversal, and suspicious Windows/UNC/DOS-device path forms before normal allow/ask decisions.
- Bash permission classification uses quote-aware splitting for pipes, redirects, wrappers, heredocs, nested execution, and compound commands, with explicit `ask` results for destructive shell patterns.
- `Git` read actions are allowed; write actions (`apply`, `stage`, `commit`) require confirmation.
- Oversized formatted tool results are saved under the project/session `tool-results/` directory and replaced with a bounded preview.
- MCP tools are policy-gated and namespaced as `serverName:toolName`; MCP resource tools expose `resources/list` and `resources/read`.

---

## 🧩 Built-in Skills

Built-in skills are **advisory workflow procedures**, not tools. They help the root agent choose a safer working style without changing tool permissions, hook blocking, or reliability guards. Auto-selection is local/deterministic and conservative; ambiguous prompts select no skill.

| Skill | Purpose | Auto trigger examples |
|-------|---------|-----------------------|
| `dev-plan` | Create or update scoped phased implementation plans | 개발 계획, 구현 계획, dev plan |
| `parallel-dev` | Split work into owned paths, contracts, and merge order | 병렬 에이전트, workstream |
| `investigate` | Debug with root-cause-first discipline | 원인 분석, 왜 깨짐, debug |
| `code-review` | Review architecture, correctness, tests, and risks | 코드 리뷰, 전문가 리뷰 |

CLI controls:

```bash
coreline-agent --list-skills
coreline-agent --show-skill dev-plan
coreline-agent -p "review src" --skill code-review --no-auto-skills
```

TUI controls:

```txt
/skill list
/skill show dev-plan
/skill use dev-plan,parallel-dev
/skill auto off
/skill clear
/skill status
```

Safety rules:

- Skills are advisory only; they never grant tool execution permission.
- Auto skill selection runs on the root agent only.
- Sub-agents receive only explicit parent guidance.
- Router input excludes code blocks, quoted examples, tool results, transcripts, and `@file` expanded file bodies.

---

## 🌐 Proxy Server

The standalone proxy exposes **Anthropic / OpenAI / Responses API** endpoints over the registered provider pool. Any upstream tool (Claude Code, Codex CLI, curl) can point at this proxy and get routed to whichever backend is available.

```bash
# Start with auto-detected providers
coreline-agent-proxy --port 4317

# With CLI fallback providers
coreline-agent-proxy --port 4317 --with-cli-fallback

# With bearer auth
coreline-agent-proxy --port 4317 --auth-token my-secret
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness + provider inventory |
| `GET` | `/v1/providers` | Provider list with capabilities |
| `GET` | `/v2/capabilities` | Full capability matrix + batch limits |
| `GET` | `/v2/status` | Current agent status snapshot for dashboards |
| `GET` | `/v2/status/stream` | SSE status stream for dashboards |
| `GET` | `/dashboard` | Read-only web dashboard shell |
| `GET` | `/.well-known/agent.json` | A2A discovery card |
| `POST` | `/a2a/tasks/send` | A2A adapter-only task intake |
| `POST` | `/hook/coreline/start` | Mark managed agent session as running |
| `POST` | `/hook/coreline/stop` | Mark managed agent session as exited/aborted |
| `POST` | `/hook/coreline/idle` | Mark managed agent session as idle |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `POST` | `/v1/responses` | OpenAI Responses API (Codex CLI) |
| `POST` | `/v2/batch` | Multi-item batch dispatch |

A2A note: `/.well-known/agent.json` and `/a2a/tasks/send` currently provide the discovery/task-intake boundary. Actual task execution is intentionally disabled by default until a separate permission-gated execution plan is implemented.

### Cross-tool Routing Examples

```bash
# Codex CLI → Claude (via proxy)
OPENAI_BASE_URL=http://127.0.0.1:4317/openai/v1 codex -m claude-sonnet-4-5

# Claude Code → GPT (via proxy)
ANTHROPIC_BASE_URL=http://127.0.0.1:4317/anthropic claude -m gpt-4o
```

### Hosted Tool Passthrough

The proxy forwards hosted tools to providers that support them:

- `web_search_20250305` / `web_search`
- `code_execution_20250825` / `code_interpreter`

### humanInputMode

Interactive tool requests (`computer_use`, `remote_mcp`) are gated:

- `humanInputMode: "return"` → HTTP 409 with `human_input_required` payload
- `humanInputMode: "forbid"` or unset → HTTP 400 rejection

See [docs/proxy-operations.md](docs/proxy-operations.md) for curl examples and operational notes.

### clideck / Dashboard Status

`coreline-agent` writes a small local status snapshot to `~/.coreline-agent/status.json`. When the proxy is running, the same data is available from `GET /v2/status` and `GET /v2/status/stream`, which lets local dashboards such as clideck show whether the agent is `idle`, `running`, `blocked`, `needs_user`, or `exited`.

The proxy also serves `GET /dashboard`, a read-only HTML status shell. It has no write actions or control forms; it only consumes `/v2/status` and the SSE stream.

See [docs/clideck-integration.md](docs/clideck-integration.md) for a preset example and resume/status integration notes.

---

## 🧠 Agent Delegation

The `Agent` tool spawns **delegated sub-agents** for research, code review, test execution, or bounded multi-child coordination.

### Architecture

```
Root Agent (depth 0)
 └─ Agent tool call
     └─ Child Agent (depth 1) — full tools, read+write
         └─ Agent tool call
             └─ Grandchild Agent (depth 2) — read-only, no Agent tool
```

### Features

| Feature | Status |
|---------|:------:|
| Single child delegation | ✅ |
| Parallel `subtasks[]` batch | ✅ |
| Partial failure reporting | ✅ |
| Child provider/model override | ✅ |
| Write-capable child (with approval) | ✅ |
| Depth-2 recursion (grandchild) | ✅ |
| Debug/transcript recording | ✅ |
| Coordinator result formatting | ✅ |
| Auto-summary of child results | ✅ |
| TUI background task list/status/read/stop | ✅ |
| `/verify` background verification task | ✅ |
| Opt-in auto verifier after plan/goal/autopilot success | ✅ |
| Workstream Card owned/non-owned prompt guidance | ✅ |
| Parallel task session export summaries | ✅ |
| Safe worktree helper candidate (no auto merge) | ✅ |
| One-shot background fallback disabled | ✅ |

### Depth Tiers

| Depth | Max Turns | Write Tools | Agent Tool | Timeout |
|:-----:|:---------:|:-----------:|:----------:|:-------:|
| 1 | 6 | ✅ (with approval) | ✅ | 5 min |
| 2 | 3 | ❌ | ❌ | 1 min |

---

## 📡 Remote Agent

Dispatch tasks to **remote coreline-agent-proxy instances** (or any Anthropic-compatible endpoint) with built-in scheduling, retry, and abort propagation.

```typescript
import { RemoteScheduler } from "./src/agent/remote/index.js";

const scheduler = new RemoteScheduler({
  endpoints: [
    { name: "gpu-server", url: "http://10.0.1.5:4317", authToken: "..." },
    { name: "cloud-proxy", url: "http://proxy.example.com:4317" },
  ],
  maxConcurrent: 4,
  retry: { maxRetries: 1, backoffMs: 1000 },
  defaultTimeoutMs: 60_000,
});

const result = await scheduler.schedule([
  { prompt: "Review src/auth.ts for security issues" },
  { prompt: "Run bun test and report failures" },
  { prompt: "Summarize recent git commits" },
]);
```

### Features

- **Windowed parallelism** — bounded concurrent dispatch across endpoint pool
- **Round-robin** with health tracking — unhealthy endpoints are skipped, retried on recovery
- **Exponential backoff retry** — configurable max retries and backoff delay
- **Abort propagation** — parent signal cancels all pending tasks
- **Partial failure** — completed results preserved even when some tasks fail
- **SubAgentRuntime compatible** — `RemoteSubAgentRuntime` implements the same interface as local delegation

---

## 📋 Plan & Goal Mode

Structured **Plan → Execute → Evaluate** workflow for complex multi-step tasks.

```bash
# CLI
bun run dev -- --plan-mode -p "review src and run tests"
bun run dev -- --goal-mode -p "ship the TypeScript fixes and verify the result"
bun run dev -- --goal-mode --resume
bun run dev -- --autopilot -p "ship the TypeScript fixes and stop only when completed or blocked"
bun run dev -- --autopilot --resume

# TUI
/plan review src and summarize risks
/goal ship the TypeScript fixes and verify the result
/autopilot ship the TypeScript fixes and stop only when completed or blocked
```

### Mode Split

- **Plan mode** — produce and run a bounded plan, then summarize the result
- **Goal mode** — run the same planner/executor loop, but persist active task state so the run can be resumed later
- **Autopilot** — keep re-running the single-agent planner/executor loop until the goal is completed, blocked, needs user input, or aborted

Goal mode is **explicit opt-in**:
- CLI: `--goal-mode`
- TUI: `/goal <goal>`

Autopilot is also **explicit opt-in**:
- CLI: `--autopilot`
- TUI: `/autopilot <goal>`

Regular chat remains unchanged.

### Flow

```
Goal → Planner → Plan (tasks[]) → Runner → Evaluator → Summary
                                     ↑                    │
                                     └── Re-planner ──────┘
                                         (on failure)
```

### Goal Run State

Goal mode stores the active run as a structured session record:

- active task id
- task verification / recovery state
- last verification summary
- last failure class / reason
- recovery rationale
- next action hint
- blocked / needs-user 상태
- resumable status

This enables **task resume**, not just message resume.

### Single-Agent Autopilot v1

Autopilot is a thin supervisor on top of goal mode:

- reuses the existing planner / executor / verifier / replanner
- keeps running until `completed`, `blocked`, `needs_user`, or `aborted`
- records a structured `decisionLog`
- detects repeated failures / repeated tails / no-progress loops
- resumes from structured run state with `--resume`

Autopilot v1 is intentionally **single-agent only**. It does not add multi-session routing or remote orchestration.

### Verification and Outputs

Each planned task can carry a verification hint so the executor knows how to judge the result:

- `exit_code` — success is determined from the recorded exit status
- `artifact` — success is tied to the presence of a file/path/output artifact
- `assertion` — success is based on a result/summary/finalText assertion

When a task finishes, the executor stores a structured output record:

- `summary` / `finalText`
- normalized `artifacts[]`
- `verificationSummary`

### Single-Agent Reliability Layer

`coreline-agent` derives reliability summaries from existing plan/session/autopilot records:

- `CompletionDecision` for completed / partial / blocked / needs-user / failed / aborted reporting
- `AgentTraceRecord` for small redacted audit events
- `RecoveryCheckpoint` and `ResumeAdvice` for advisory resume context
- `VerificationPack` for completion evidence bundles

The existing `PlanRunRecord`, task status, evaluation, verification, and decision log remain the source of truth.

```bash
bun run smoke:agent
```

See [docs/single-agent-reliability.md](docs/single-agent-reliability.md).

### Single-Agent Hardening Helpers

- File writes/edits create a session-scoped backup under `~/.coreline-agent/backups/`.
- TUI `/undo` restores the latest file backup for the current session.
- `FileEdit` tool results include a truncated unified diff preview.
- `--test-loop [command]` and `/test-loop [command]` run the explicit test helper.
- `--budget <dollars>` shows cost in the TUI status bar and emits budget warnings.
- `--budget-stop` stops the current loop when the budget is exceeded.

### Operator Intelligence Helpers

- `/context current` or `/context <prompt>` suggests relevant local files without auto-attaching file contents.
- `/macro parse <macro-json-or-lines>` validates a prompt macro and adapts it to the existing pipeline contract.
- `src/agent/benchmark/` provides deterministic mock benchmark primitives for regression checks without external LLM calls.
- Macro persistence/execution history is intentionally deferred; v1 focuses on parse/validate/pipeline adapter safety.

### Task-State Rules

- `needs_user` — explicit user approval / confirmation / input이 필요할 때 사용됩니다.
  - non-interactive CLI에서는 기다리지 않고 `needs_user`로 종료되어 deadlock을 피합니다.
- `blocked` — 외부 의존성 / 네트워크 / provider / upstream 문제로 진행이 막혔을 때 사용됩니다.
  - 일반 도구 실패(`permission denied`, 잘못된 입력, 구현 오류)는 `failed`로 남습니다.
- `verified` — 구조적/애매한 결과라도 검증은 통과했지만, 최종 완료 판정은 아닐 수 있습니다.
- `completed` — deterministic verification contract가 만족되어 명확히 완료된 상태입니다.

### Re-planning

When a task fails, the **re-planner** preserves completed tasks and rebuilds the remaining tail:

- Completed prefix tasks are kept intact
- Failed task + remaining tasks are re-planned with failure context
- Local `retryBudget` is consumed **before** any re-plan attempt
- `maxReplansPerTask` only limits tail re-planning after retries are exhausted

---

## 💾 Memory System

Project-scoped persistent memory that survives across sessions.

### How It Works

1. **AGENT.md / CLAUDE.md** — loaded from the repo hierarchy (memory-independent)
2. **Project memory** — stored under `~/.coreline-agent/projects/{projectId}/memory/`
3. **MemoryRead / MemoryWrite** tools — agent can read and save durable facts
4. **Auto-summary** — on conversation end, key information is automatically extracted and saved
5. **Secret scanner** — MemoryWrite/summary paths reject high-confidence secrets such as AWS, GitHub, OpenAI, Anthropic, Slack, npm tokens, private keys, and generic password/secret/token assignments

### Auto-Summary

After a substantive conversation (3+ turns, completed normally), the agent automatically extracts and saves durable information — user preferences, project rules, important decisions.

```bash
# Disable auto-summary
bun run dev -- --no-auto-summary

# Or via env
CORELINE_NO_AUTO_SUMMARY=1 bun run dev
```

See [docs/memory-system.md](docs/memory-system.md) for details.

---

## 🔗 MCP Tool Bridge

Connect external tool servers via the [Model Context Protocol](https://modelcontextprotocol.io).

### Configuration

Create `~/.coreline-agent/mcp.yml`:

```yaml
defaultServer: filesystem
servers:
  - name: filesystem
    command: npx
    args: ["-y", "@anthropic/mcp-filesystem-server", "/home/user/projects"]
  - name: github
    command: npx
    args: ["-y", "@anthropic/mcp-github-server"]
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
```

### Usage

MCP tools are namespaced as `serverName:toolName` and appear in the agent's tool list:

```
filesystem:read_file, filesystem:write_file, github:search_repos, ...
```

MCP resources are available through built-in tools when MCP is configured:

- `ListMcpResources` — list resource descriptors from the default, selected, or named server
- `ReadMcpResource` — return text resources directly and store blob/base64 resources in `tool-results/`

See [docs/mcp-ops.md](docs/mcp-ops.md) for operational details.

---

## 📎 @file Attachments

Inline file attachments in prompts — works in both CLI and TUI:

```bash
# Single file
bun run dev -- -p "review @src/index.ts"

# Multiple files
bun run dev -- -p "compare @src/old.ts and @src/new.ts"

# Glob pattern
bun run dev -- -p "summarize @src/*.ts"
```

- File contents are appended to the user message before sending
- Duplicate references are deduplicated
- Missing / binary / oversized files are reported as attachment issues
- Resume view collapses attached file contents into a compact summary

---

## 🎛️ Operator UX: Roles, Prompts, Context, Macros, and Transcript Replay

Reusable role presets and prompt snippets are local-file based.

```bash
# Inject a role into the system prompt
coreline-agent --role reviewer
```

Built-in roles:

- `reviewer`
- `planner`
- `coder`

TUI commands:

```text
/role reviewer
/prompt save review-checklist
/prompt list
/prompt use review-checklist
/prompt delete review-checklist
/context current
/context src/index.ts provider router
/macro parse {"id":"check","name":"Check","steps":[{"prompt":"run tests"}]}
/search provider bug
/replay
/replay <sessionId>
```


Operator utility commands:

```text
/scaffold tool MyTool
/set
/set maxTurns 10
/reset maxTurns
/verify
/verify test
/agents
/agent status <taskId>
```

`/set` changes apply from the next turn. `/verify` runs detected `typecheck`, `build`, and `test` scripts through the Parallel Agent Runtime task registry so the result can be inspected with `/agents` and `/agent read <taskId>`. When `CORELINE_AUTO_VERIFY=1` is set, successful plan/goal/autopilot runs can enqueue the same verifier path as a non-blocking background task. Session exports include compact parallel task summaries/evidence, not raw child transcripts.

Storage:

- `~/.coreline-agent/roles.yml` or `roles.json`
- `~/.coreline-agent/prompts/*.json`
- `~/.coreline-agent/sessions/*.jsonl` with normalized `transcript_entry` records

---

## ⚙️ Configuration

### Runtime Config

Optional `~/.coreline-agent/config.yml`:

```yaml
defaultProvider: claude
theme: dark        # default | dark | light
maxTurns: 50
```

### Permissions

Optional `~/.coreline-agent/permissions.yml`:

```yaml
mode: default      # default | acceptAll | denyAll
rules:
  - toolName: Bash
    behavior: ask
  - toolName: FileWrite
    behavior: ask
    pattern: "*.config.*"
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic provider auth |
| `OPENAI_API_KEY` | OpenAI provider auth |
| `GOOGLE_API_KEY` | Gemini provider auth |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth (alternative to API key) |
| `PROXY_PORT` | Proxy listen port (default: 4317) |
| `PROXY_HOST` | Proxy listen host (default: 127.0.0.1) |
| `PROXY_AUTH_TOKEN` | Require bearer token on proxy requests |
| `CORELINE_NO_AUTO_SUMMARY` | Disable memory auto-summary (`1` to disable) |
| `CODEX_AUTH_PATH` | Override Codex backend OAuth file path |
| `CODEX_CONFIG_PATH` | Override Codex backend `config.toml` path |

---

## 🧪 Testing

```bash
# Full test suite
bun test                    # 1504 tests across 205 files

# Type checking
bun run typecheck           # tsc --noEmit

# Build
bun run build               # Bun bundler → dist/

# Smoke suites
bun run smoke
bun run smoke:proxy
bun run smoke:agent
bun run smoke:provider:ci-safe

# Proxy tests only
bun test tests/proxy-*.test.ts

# Agent delegation / pipeline tests
bun test tests/subagent-*.test.ts tests/agent-tool*.test.ts tests/pipeline-*.test.ts

# Reliability / hardening tests
bun test tests/reliability-*.test.ts tests/file-transaction.test.ts tests/tool-cache.test.ts tests/git-tool.test.ts

# Memory tests
bun test tests/memory-*.test.ts

# Plan-execute tests
bun test tests/plan-execute-*.test.ts

# Built-in skill tests
bun test tests/skill-*.test.ts tests/builtin-skills.test.ts
```


### Internal Hook Engine

`coreline-agent` also includes an internal, in-memory Hook Engine for runtime events such as `StatusChange`, `PreTool`, and `PostTool`. This is separate from the `/hook/coreline/*` clideck status endpoints. Supported hook executors are `function`, localhost/allowlisted `http`, and an internal opt-in `command` safe runner. Command hooks are disabled by default; public hook registration APIs remain intentionally out of scope.

See [docs/hook-engine.md](docs/hook-engine.md).

### Provider Smoke Tests

```bash
# Local models only (Ollama)
bun run smoke:provider:compatible

# Cloud providers (requires API keys)
bun run smoke:provider:cloud

# All providers
bun run smoke:provider:all
```

See [docs/provider-smoke-checklist.md](docs/provider-smoke-checklist.md) and [docs/provider-smoke-ci.md](docs/provider-smoke-ci.md).

---

## 📁 Project Structure

```
src/
├── index.ts                 # CLI entrypoint
├── proxy-cli.ts             # Proxy server entrypoint
├── agent/
│   ├── loop.ts              # Core agent loop (turn-based)
│   ├── context.ts           # AppState / ToolUseContext
│   ├── system-prompt.ts     # System prompt builder + skills/hardening hints
│   ├── subagent-types.ts    # Sub-agent contracts
│   ├── subagent-runtime.ts  # Local child agent execution
│   ├── subagent-root.ts     # Root runtime factory
│   ├── pipeline-*.ts        # Sequential handoff pipeline contracts/runtime
│   ├── plan-execute/        # Plan-Execute-Evaluate engine
│   ├── reliability/         # CompletionJudge, trace, recovery, verification pack
│   ├── benchmark/           # Deterministic mock benchmark primitives
│   └── remote/              # Remote agent dispatch
├── providers/               # 9 LLM provider adapters
├── proxy/                   # Local HTTP proxy, API mappers, A2A, SSE status
├── dashboard/               # Read-only status dashboard shell
├── integrations/            # clideck and external adapter contracts
├── hooks/                   # Internal Hook Engine + executors/adapters
├── tools/                   # 12 core tools + MCP bridge/resource adapters
│   ├── agent/
│   ├── bash/
│   ├── file-read/
│   ├── file-write/
│   ├── file-edit/
│   ├── git/
│   ├── glob/
│   ├── grep/
│   ├── mcp/
│   ├── mcp-resources/
│   ├── memory-read/
│   ├── memory-write/
│   ├── todo-write/
│   └── ask-user-question/
├── tui/                     # Terminal UI (Ink/React)
├── memory/                  # Project memory + AGENT.md/CLAUDE.md loader
├── config/                  # YAML config loading, diagnostics, provenance
├── session/                 # Session history, transcript search/replay/export
├── permissions/             # Permission engine, parser, matcher, classifier
├── prompt/                  # @file parser, prompt library, prompt macro
├── skills/                  # Built-in skill catalog, registry, router
├── mcp/                     # MCP stdio bridge
└── utils/                   # Shared utilities
```

---


## 📄 Documentation

| Document | Description |
|----------|-------------|
| [docs/README.md](docs/README.md) | Documentation index and source-of-truth guide |
| [docs/implementation-status.md](docs/implementation-status.md) | Current implementation baseline, archived plan status, and deliberate follow-ups |
| [docs/memory-system.md](docs/memory-system.md) | Memory system design and usage |
| [docs/proxy-operations.md](docs/proxy-operations.md) | Proxy curl examples and operational notes |
| [docs/clideck-integration.md](docs/clideck-integration.md) | clideck preset and status integration guide |
| [docs/mcp-ops.md](docs/mcp-ops.md) | MCP bridge configuration and operations |
| [docs/cloud-oauth-providers.md](docs/cloud-oauth-providers.md) | OAuth setup for Codex / Gemini Code Assist |
| [docs/provider-smoke-checklist.md](docs/provider-smoke-checklist.md) | Provider smoke test procedures |
| [docs/provider-smoke-ci.md](docs/provider-smoke-ci.md) | CI smoke test automation |
| [docs/hook-engine.md](docs/hook-engine.md) | Internal Hook Engine behavior and safety policy |
| [docs/smoke.md](docs/smoke.md) | Smoke test standard and selected proxy smoke scope |

---

## 📜 License

[MIT](LICENSE)

---

<div align="center">
<sub>Built with <a href="https://bun.sh">Bun</a> · <a href="https://github.com/vadimdemedes/ink">Ink</a> · <a href="https://www.typescriptlang.org">TypeScript</a></sub>
</div>
