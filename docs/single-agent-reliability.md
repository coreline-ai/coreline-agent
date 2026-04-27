# Single-Agent Reliability Layer

`coreline-agent` keeps the existing plan/session/autopilot records as the source of truth and derives a lightweight reliability layer from them.

## Source of truth

The canonical state remains:

- `PlanRunRecord.status`
- `Task.status`
- `EvaluationResult`
- `TaskVerification`
- `TaskRecovery`
- `AutopilotDecisionRecord`
- transcript/session records

Reliability objects are derived summaries only:

- `CompletionDecision` — final run outcome for user reporting
- `AgentTraceRecord` — structured audit events for tools, permissions, hooks, evaluation, recovery, and verification
- `RecoveryCheckpoint` / `ResumeAdvice` — advisory resume context, never an execution blocker
- `VerificationPack` — evidence bundle for completion claims

## Completion judgment

`judgeCompletion()` classifies a run using deterministic evidence first:

```text
aborted > needs_user > blocked > failed > partial > completed > unknown
```

It reads task status, evaluation results, verification records, tool errors, permission denials, hook blocking, and caller-provided evidence. It does not replace the task evaluator.

## Trace records

Trace metadata is intentionally small and redacted:

- no raw prompts
- no API keys, tokens, passwords, or credentials
- no full file content
- no full command output
- long metadata is truncated
- redaction can reuse the shared memory secret scanner (`scanForSecrets` / `redactSecrets`) so provider tokens and common API key formats are labeled without exposing matched values

Trace records are structured session records and do not pollute the default transcript replay/search output.

## Recovery advice

`RecoveryCheckpoint` and `ResumeAdvice` summarize where a run stopped and what should happen next. `doNotRepeat[]` is advisory only. It does not automatically block tool execution.

## Verification pack

`VerificationPack` is a collector/aggregator, not an executor. It can collect evidence from:

- `PlanExecutionResult.plan.tasks[].verification`
- `PlanExecutionResult.steps[].evaluation`
- `TaskOutput.verificationSummary`
- verification/output/file/path artifacts
- tool result summaries
- plan run status/summary/failure context
- agent trace summaries
- caller-provided external evidence

It never runs tests, commands, tools, providers, or hooks by itself.

## Smoke test

```bash
bun run smoke:agent
```

The smoke is mock-first and does not call cloud LLM APIs or external networks.
