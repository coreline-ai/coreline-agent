import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentTraceRecord as createSessionAgentTraceRecord,
  isAgentTraceRecord,
  parseSessionLine,
} from "../src/session/records.js";
import {
  createAgentTraceRecord,
  createTraceRecorder,
  sanitizeTraceMetadata,
  TRACE_METADATA_MAX_STRING_LENGTH,
} from "../src/agent/reliability/trace-recorder.js";
import { replaySession } from "../src/session/replay.js";
import { searchTranscripts } from "../src/session/search.js";
import { paths } from "../src/config/paths.js";
import { appendAgentTraceRecord, loadAgentTraceRecords, loadSession } from "../src/session/storage.js";

describe("agent reliability trace recorder", () => {
  test("creates and sinks structured agent trace records", () => {
    const records: ReturnType<typeof createAgentTraceRecord>[] = [];
    const recorder = createTraceRecorder("session-trace", (record) => {
      records.push(record);
    });

    const record = recorder.recordTrace({
      eventKind: "tool_executed",
      toolName: "Bash",
      toolUseId: "tool-1",
      outcome: "success",
      reason: "command completed",
      metadata: { exitCode: 0 },
    });

    expect(record).toMatchObject({
      _type: "agent_trace",
      sessionId: "session-trace",
      eventKind: "tool_executed",
      toolName: "Bash",
      toolUseId: "tool-1",
      outcome: "success",
      metadata: { exitCode: 0 },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);
    expect(records[0]?.traceId).toBeString();
    expect(records[0]?.timestamp).toBeString();
  });

  test("redacts secrets and omits raw prompt, file content, and full command output", () => {
    const record = createAgentTraceRecord("session-secure", {
      eventKind: "tool_failed",
      reason: "Authorization: Bearer secret-token-1234567890 failed",
      metadata: {
        apiKey: "sk-test-super-secret-value",
        token: "ghp_abcdefghijklmnopqrstuvwxyz",
        prompt: "please read the whole repository",
        fileContent: "const secret = 'abc';\n".repeat(40),
        fullCommandOutput: "line\n".repeat(200),
        nested: {
          password: "hunter2-secret",
          note: "token=abcdef1234567890 should be hidden",
        },
      },
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("sk-test-super-secret-value");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("please read the whole repository");
    expect(serialized).not.toContain("const secret");
    expect(serialized).not.toContain("line\\nline");
    expect(serialized).toContain("[REDACTED]");
    expect(record.metadata).toMatchObject({
      apiKey: "[REDACTED]",
      token: "[REDACTED]",
      prompt: "[omitted:raw-content]",
      fileContent: "[omitted:raw-content]",
      fullCommandOutput: "[omitted:raw-content]",
      nested: {
        password: "[REDACTED]",
      },
    });
  });

  test("truncates long metadata values with a constant limit", () => {
    const metadata = sanitizeTraceMetadata({
      short: "ok",
      long: "x".repeat(TRACE_METADATA_MAX_STRING_LENGTH + 100),
    });

    expect(metadata?.short).toBe("ok");
    expect(typeof metadata?.long).toBe("string");
    expect((metadata?.long as string).length).toBeLessThanOrEqual(TRACE_METADATA_MAX_STRING_LENGTH);
    expect(metadata?.long).toContain("[truncated");
  });

  test("session parser recognizes agent_trace as an additive structured record", () => {
    const record = createSessionAgentTraceRecord({
      traceId: "trace-1",
      sessionId: "session-parse",
      timestamp: "2026-04-19T00:00:00.000Z",
      eventKind: "permission_deny",
      reason: "user denied write",
      outcome: "blocked",
    });

    expect(isAgentTraceRecord(record)).toBe(true);
    const parsed = parseSessionLine(JSON.stringify(record));
    expect(parsed.kind).toBe("structured");
    if (parsed.kind === "structured") {
      expect(parsed.record).toMatchObject({
        _type: "agent_trace",
        traceId: "trace-1",
        sessionId: "session-parse",
        eventKind: "permission_deny",
      });
    }
  });

  test("agent_trace records do not pollute transcript replay or search defaults", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "coreline-agent-trace-"));
    try {
      writeFileSync(
        join(sessionsDir, "session-trace-ux.jsonl"),
        [
          JSON.stringify({ _type: "agent_trace", traceId: "trace-hidden", sessionId: "session-trace-ux", timestamp: "2026-04-19T00:00:00.000Z", eventKind: "hook_blocking", reason: "hidden trace marker" }),
          JSON.stringify({ _type: "transcript_entry", sessionId: "session-trace-ux", timestamp: "2026-04-19T00:00:01.000Z", role: "user", text: "visible user message", turnIndex: 1 }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const replay = replaySession("session-trace-ux", { sessionsDir });
      expect(replay).toContain("visible user message");
      expect(replay).not.toContain("hidden trace marker");

      const results = searchTranscripts("hidden trace marker", { sessionsDir });
      expect(results).toHaveLength(0);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test("session storage can append and load agent trace records separately", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "coreline-agent-trace-storage-"));
    const originalSessionsDir = paths.sessionsDir;
    try {
      (paths as { sessionsDir: string }).sessionsDir = sessionsDir;
      appendAgentTraceRecord("session-storage-trace", {
        traceId: "trace-storage",
        eventKind: "completion_decision",
        reason: "completed with evidence",
        outcome: "completed",
      });

      const loaded = loadSession("session-storage-trace");
      expect(loaded?.messages).toHaveLength(0);
      expect(loaded?.planRuns).toHaveLength(0);
      expect(loaded?.agentTraces).toHaveLength(1);
      expect(loadAgentTraceRecords("session-storage-trace")[0]).toMatchObject({
        traceId: "trace-storage",
        eventKind: "completion_decision",
        outcome: "completed",
      });
    } finally {
      (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
