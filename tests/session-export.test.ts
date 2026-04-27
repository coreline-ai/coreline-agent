import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/paths.js";
import { exportSessionMarkdown, exportSessionPrDescription, exportSessionToText } from "../src/session/export.js";
import { appendAgentTraceRecord, appendMessage, appendPlanRunRecord, appendSubAgentRunRecord, writeSessionHeader } from "../src/session/storage.js";
import type { ChatMessage } from "../src/agent/types.js";
import type { ParallelAgentRegistrySnapshot, ParallelAgentTaskRecord } from "../src/agent/parallel/types.js";

describe("session export", () => {
  test("exports a mixed session to markdown, text, and PR draft formats", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "coreline-session-export-"));
    const originalSessionsDir = paths.sessionsDir;
    try {
      (paths as { sessionsDir: string }).sessionsDir = sessionsDir;

      const sessionId = "session-export-demo";
      writeSessionHeader(sessionId, {
        provider: "mock-provider",
        model: "mock-model",
        cwd: "/tmp/demo",
      });

      const userMessage: ChatMessage = {
        role: "user",
        content: "Please review this file and summarize the risks.",
      };
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "I will review the file." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "FileRead",
            input: { path: "src/index.ts" },
          },
          {
            type: "tool_result",
            toolUseId: "tool-1",
            content: "A".repeat(1200),
            isError: false,
          },
        ],
      };
      appendMessage(sessionId, userMessage);
      appendMessage(sessionId, assistantMessage);

      appendPlanRunRecord(sessionId, {
        planRunId: "plan-1",
        goal: "Review and summarize risks",
        sessionId,
        createdAt: "2026-04-19T09:00:00.000Z",
        mode: "plan",
        source: "cli",
        cwd: "/tmp/demo",
        providerName: "mock-provider",
        model: "mock-model",
        plan: {
          goal: "Review and summarize risks",
          tasks: [
            {
              id: "task-1",
              description: "Read source files",
              dependsOn: [],
              status: "completed",
            },
          ],
        },
        steps: [
          {
            task: {
              id: "task-1",
              description: "Read source files",
              dependsOn: [],
              status: "completed",
            },
            output: {
              summary: "Read the requested files.",
            },
          },
        ],
        summary: {
          completed: 1,
          failed: 0,
          ambiguous: 0,
          verified: 1,
        },
        completed: true,
        status: "completed",
        resultText: "Plan complete.",
        lastVerificationSummary: "All checks passed.",
      });

      appendSubAgentRunRecord(sessionId, {
        childId: "child-1",
        sessionId,
        createdAt: "2026-04-19T09:01:00.000Z",
        cwd: "/tmp/demo",
        providerName: "mock-provider",
        model: "mock-model",
        prompt: "Review the file",
        summary: "Looked at src/index.ts",
        finalText: "Final output from child agent.",
        turns: 2,
        usedTools: ["FileRead"],
        success: true,
        status: "completed",
        resultKind: "single",
      });

      appendAgentTraceRecord(sessionId, {
        traceId: "trace-1",
        eventKind: "completion_decision",
        reason: "completed with evidence",
        outcome: "completed",
      });

      const markdown = exportSessionMarkdown(sessionId, { maxContentLength: 120 });
      expect(markdown).toContain("# Session Export");
      expect(markdown).toContain("## Summary");
      expect(markdown).toContain("## Conversation");
      expect(markdown).toContain("## Plan Runs");
      expect(markdown).toContain("## Sub-agent Runs");
      expect(markdown).toContain("## Traces");
      expect(markdown).toContain("mock-provider");
      expect(markdown).toContain("[tool result]");
      expect(markdown).toContain("truncated");

      const text = exportSessionToText(sessionId, { maxContentLength: 120 });
      expect(text).toContain("Session Export");
      expect(text).toContain("Conversation");
      expect(text).toContain("Plan Runs");

      const pr = exportSessionPrDescription(sessionId, { maxContentLength: 120 });
      expect(pr).toContain("## Summary");
      expect(pr).toContain("## Changes");
      expect(pr).toContain("## Verification");
      expect(pr).toContain("Trace records: 1");
    } finally {
      (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test("includes parallel agent task summaries without leaking raw child transcript", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "coreline-session-export-parallel-"));
    const originalSessionsDir = paths.sessionsDir;
    try {
      (paths as { sessionsDir: string }).sessionsDir = sessionsDir;

      const sessionId = "session-export-parallel";
      writeSessionHeader(sessionId, { provider: "mock", model: "mock", cwd: "/tmp/demo" });

      const longFinalText = "SECRET_RAW_TRANSCRIPT_" + "x".repeat(800);
      const task: ParallelAgentTaskRecord = {
        id: "pa-verify-1",
        prompt: "Run hidden verification prompt that should not be exported",
        description: "Background verification: test",
        status: "completed",
        cwd: "/tmp/demo",
        provider: "mock",
        model: "mock",
        agentDepth: 1,
        write: false,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:01:00.000Z",
        startedAt: "2026-04-20T10:00:05.000Z",
        finishedAt: "2026-04-20T10:01:00.000Z",
        summary: "Verification passed.",
        finalText: longFinalText,
        usedTools: ["Bash"],
        transcriptPath: "/tmp/private-transcript.jsonl",
        outputPath: "/tmp/private-output.txt",
        structuredResult: {
          status: "completed",
          summary: "Verification passed.",
          changedFiles: [],
          readFiles: ["src/session/export.ts"],
          commandsRun: ["bun test tests/session-export.test.ts"],
          testsRun: [
            { command: "bun test tests/session-export.test.ts", status: "pass", outputSummary: "ok" },
          ],
          risks: [],
          nextActions: [],
        },
      };

      const snapshot: ParallelAgentRegistrySnapshot = {
        tasks: [task],
        runningCount: 0,
        pendingCount: 0,
        completedCount: 1,
        failedCount: 0,
        abortedCount: 0,
        timeoutCount: 0,
      };

      const markdown = exportSessionMarkdown(sessionId, { parallelTasks: snapshot, maxContentLength: 120 });
      expect(markdown).toContain("## Parallel Agent Tasks");
      expect(markdown).toContain("taskId: pa-verify-1");
      expect(markdown).toContain("Verification passed.");
      expect(markdown).toContain("bun test tests/session-export.test.ts=pass");
      expect(markdown).not.toContain("SECRET_RAW_TRANSCRIPT");
      expect(markdown).not.toContain("private-transcript");
      expect(markdown).not.toContain("hidden verification prompt");

      const text = exportSessionToText(sessionId, { parallelTasks: [task], maxContentLength: 120 });
      expect(text).toContain("Parallel Agent Tasks");
      expect(text).toContain("tasks: 1");
      expect(text).toContain("pa-verify-1: completed");
      expect(text).not.toContain("readFiles:");
      expect(text).not.toContain("SECRET_RAW_TRANSCRIPT");

      const pr = exportSessionPrDescription(sessionId, { parallelTasks: [task], maxContentLength: 120 });
      expect(pr).toContain("Parallel agent tasks: 1");
      expect(pr).toContain("Background verification tasks: 1");
      expect(pr).toContain("commands: bun test tests/session-export.test.ts");
      expect(pr).toContain("tests: bun test tests/session-export.test.ts=pass");
      expect(pr).not.toContain("SECRET_RAW_TRANSCRIPT");
      expect(pr).not.toContain("private-output");
    } finally {
      (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test("throws a readable error for missing or empty sessions", () => {
    expect(() => exportSessionMarkdown("missing-session")).toThrow("찾을 수 없습니다");

    const sessionsDir = mkdtempSync(join(tmpdir(), "coreline-session-export-empty-"));
    const originalSessionsDir = paths.sessionsDir;
    try {
      (paths as { sessionsDir: string }).sessionsDir = sessionsDir;
      writeFileSync(join(sessionsDir, "empty-session.jsonl"), JSON.stringify({
        _type: "session_header",
        sessionId: "empty-session",
        createdAt: "2026-04-19T00:00:00.000Z",
      }) + "\n", "utf-8");

      expect(() => exportSessionToText("empty-session")).toThrow("내보낼 내용이 없습니다");
    } finally {
      (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test("PR draft includes summary, changes, and verification sections", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "coreline-session-export-pr-"));
    const originalSessionsDir = paths.sessionsDir;
    try {
      (paths as { sessionsDir: string }).sessionsDir = sessionsDir;

      const sessionId = "session-export-pr";
      writeSessionHeader(sessionId, { provider: "mock", model: "mock", cwd: "/tmp/demo" });
      appendMessage(sessionId, { role: "user", content: "one" });
      appendAgentTraceRecord(sessionId, {
        traceId: "trace-pr",
        eventKind: "tool_executed",
        reason: "ok",
        toolName: "Bash",
        toolUseId: "tool-1",
        outcome: "success",
      });

      const pr = exportSessionPrDescription(sessionId);
      expect(pr).toContain("## Summary");
      expect(pr).toContain("## Changes");
      expect(pr).toContain("## Verification");
      expect(pr).toContain("Session ID");
      expect(pr).toContain("Trace records: 1");
    } finally {
      (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
