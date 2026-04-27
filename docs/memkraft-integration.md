# 메모리 레퍼런스 Integration Guide

This guide describes the 메모리 레퍼런스-derived capabilities layered on top of the
existing coreline-agent memory system: a 3-tier memory classification, a
cross-session recall index, a self-improvement loop (skill/subagent/prompt
evidence), tier-aware convergence stopping, and a digest snapshot.

All features are strictly additive: existing memory entries without
메모리 레퍼런스 frontmatter continue to work (defaults to `recall` tier), and all
integrations are best-effort — failures never break a session.

## Overview

coreline-agent borrows four ideas from the upstream 메모리 레퍼런스 project:

1. A 3-tier memory hierarchy (`core` / `recall` / `archival`) that replaces
 flat memory with a working-set selector.
2. An append-only JSONL evidence log of every skill, subagent, prompt, and
 plan-iteration run, aggregated by `summariseEval` and evaluated for
 convergence by `checkConvergence`.
3. A cross-session recall index (sessions tokenised at end, searchable via
 the `MemoryRecall` tool).
4. A digest renderer (`/memory digest` → `MEMORY.md`) that snapshots hot
 memory so it can be git-committed and shared across agents.

## Usage Scenarios

### 1. Setting a memory tier

Every `MemoryWrite` result can include an optional `tier` in its frontmatter.
Auto-summary maps types to tiers by default (`user`/`feedback`/`project` →
`core`, `reference` → `recall`). Override manually:

```md
---
name: coding_style
type: project
tier: core
importance: high
---
Always prefer 2-space indent.
```

### 2. Generating a digest and committing it

```
/memory digest
```

Writes `~/.coreline-agent/projects/{projectId}/MEMORY.md`. The digest is also
auto-generated on graceful session end. Commit it into your repo to share the
hot working set across agents/teammates.

### 3. Inspecting skill performance

```
/skill stats
```

Reports per-skill pass rate, average turns, and convergence verdict from the
evidence log. Use it before disabling or reinforcing a skill.

### 4. Compacting before a critical session

```
/memory compact --dry-run
/memory compact --max-chars 12000
```

Moves stale or low-importance entries to `archival` so the working set stays
focused during long-context tasks.

### 5. Cross-session recall with MemoryRecall

When the agent asks "did we discuss X?", the `MemoryRecall` tool searches the
session-recall index (past 90 days by default) and surfaces matching past
session summaries. No fuzzy full-text search — it uses token-containment
similarity, so queries should include domain words.

## Slash commands

| Command | Purpose |
|---------|---------|
| `/memory digest` | Render `MEMORY.md` snapshot to `~/.coreline-agent/projects/{id}/MEMORY.md`. |
| `/memory compact [--dry-run] [--max-chars N]` | Archive stale/low-importance entries. |
| `/memory promote [--dry-run]` | Promote `recall` entries with `accessCount >= 3` to `core`. |
| `/skill stats` | Per-skill pass rate and convergence verdict. |
| `/subagent stats` | Per-subagent-type run history summary. |
| `/prompt evidence` | List prompt evidence ids. |
| `/prompt experiment` | Register/list/pick prompt A/B variants. |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CORELINE_WORKING_SET_LIMIT` | `8` | Max entries surfaced in the system prompt Memory section. Core always included. |
| `CORELINE_AUTO_PROMOTE` | `1` | Set `0` to disable automatic recall→core promotion via session tick. |
| `CORELINE_DISABLE_CONVERGENCE_AUTOSTOP` | unset | Set `1` to keep plan iterations running even when `checkConvergence` reports converged. |
| `CORELINE_DEBUG_PROMPT` | unset | Set `1` to emit working-set counts as HTML comment in system prompt. |

## Evidence JSONL locations

All evidence files are per-project under
`~/.coreline-agent/projects/{projectId}/`:

| Domain | Directory | File |
|--------|-----------|------|
| `skill` | `evidence/skills/` | `{skillId}.jsonl` |
| `subagent` | `evidence/subagents/` | `{subagentType}.jsonl` |
| `prompt` | `evidence/prompts/` | `{promptName}.jsonl` |
| `plan-iteration` | `evidence/skills/_plan/` | `{planId}.jsonl` |

Each line is a single `EvidenceRecord` JSON object. Corrupted lines are
silently skipped during reads. Appends are best-effort: disk errors surface
as `{recorded: false, error}` but never throw.

## Tier-aware convergence

`checkConvergence` supports a `tier` option that sets the default
staleness cutoff from `TIER_STALE_DAYS` (core: 180d, recall: 60d,
archival: never). `tier-aware-convergence.ts` wraps this with the
entity's `tierOf` lookup so callers can pass a memory id directly.

## Related docs

- [memory-system.md](memory-system.md) — base memory storage and tiers
- [implementation-status.md](implementation-status.md) — per-phase status
