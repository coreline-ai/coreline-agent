/**
 * Session debug storage tests — child execution records + resume compatibility.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/paths.js";
import {
  appendMessage,
  appendSubAgentRunRecord,
  saveSubAgentRun,
  loadSession,
  loadSubAgentRuns,
  listSessions,
  writeSessionHeader,
} from "../src/session/storage.js";
import { SessionManager } from "../src/session/history.js";
import type { ChatMessage } from "../src/agent/types.js";

describe("Session debug storage", () => {
  let tmpDir: string;
  let originalSessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-session-debug-"));
    originalSessionsDir = paths.sessionsDir;
    (paths as { sessionsDir: string }).sessionsDir = tmpDir;
  });

  afterEach(() => {
    (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadSession keeps legacy messages and sub-agent records separate", () => {
    const sessionId = "session-legacy-debug";
    writeSessionHeader(sessionId, {
      provider: "mock",
      model: "mock",
      cwd: "/tmp/project",
    });

    const msg1: ChatMessage = { role: "user", content: "hello" };
    const msg2: ChatMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    };

    appendMessage(sessionId, msg1);
    saveSubAgentRun(sessionId, {
      childId: "child-1",
      sessionId,
      createdAt: "2026-04-16T00:00:00.000Z",
      parentToolUseId: "tool-1",
      cwd: "/tmp/project",
      providerName: "mock",
      model: "mock",
      prompt: "review package.json",
      usedTools: ["FileRead"],
      summary: "Reviewed package.json",
      finalText: "Looks good.",
      turns: 2,
      success: true,
      status: "completed",
      transcript: [msg1, msg2],
    });
    appendSubAgentRunRecord(sessionId, {
      childId: "child-2",
      sessionId,
      createdAt: "2026-04-16T00:00:01.000Z",
      parentToolUseId: "tool-2",
      cwd: "/tmp/project",
      providerName: "mock",
      model: "mock",
      prompt: "run tests",
      usedTools: ["Bash"],
      summary: "Ran tests",
      finalText: "All tests passed.",
      turns: 1,
      success: true,
      status: "completed",
    });
    appendMessage(sessionId, msg2);

    const loaded = loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]).toEqual(msg1);
    expect(loaded?.messages[1]).toEqual(msg2);
    expect(loaded?.subAgentRuns).toHaveLength(2);
    expect(loaded?.subAgentRuns[0]).toMatchObject({
      _type: "sub_agent_run",
      childId: "child-1",
      sessionId,
      parentToolUseId: "tool-1",
      cwd: "/tmp/project",
      providerName: "mock",
      model: "mock",
      prompt: "review package.json",
      usedTools: ["FileRead"],
      summary: "Reviewed package.json",
      finalText: "Looks good.",
      turns: 2,
      success: true,
      status: "completed",
    });
    expect(loaded?.subAgentRuns[0]?.transcript).toEqual([msg1, msg2]);
    expect(loaded?.subAgentRuns[1]).toMatchObject({
      childId: "child-2",
      usedTools: ["Bash"],
      summary: "Ran tests",
      finalText: "All tests passed.",
      success: true,
    });
  });

  test("SessionManager can load sub-agent runs and opt out of saving", () => {
    const enabled = new SessionManager({
      providerName: "mock",
      model: "mock",
    });

    enabled.saveSubAgentRun({
      childId: "child-enabled",
      createdAt: "2026-04-16T00:00:00.000Z",
      cwd: process.cwd(),
      prompt: "run a review",
      status: "completed",
      summary: "done",
      success: true,
    });

    const enabledRecords = enabled.loadSubAgentRuns();
    expect(enabledRecords).toHaveLength(1);
    expect(enabledRecords[0]!.childId).toBe("child-enabled");

    const disabled = new SessionManager({
      providerName: "mock",
      model: "mock",
      recordChildExecutions: false,
    });

    disabled.saveSubAgentRun({
      childId: "child-disabled",
      createdAt: "2026-04-16T00:00:00.000Z",
      cwd: process.cwd(),
      prompt: "do not save",
      status: "completed",
    });

    expect(disabled.loadSubAgentRuns()).toHaveLength(0);
  });

  test("listSessions counts only chat messages", () => {
    const sessionId = "session-count";
    writeSessionHeader(sessionId, {
      provider: "mock",
      model: "mock",
      cwd: "/tmp/project",
    });

    appendMessage(sessionId, { role: "user", content: "hello" });
    saveSubAgentRun(sessionId, {
      childId: "child-count",
      sessionId,
      createdAt: "2026-04-16T00:00:00.000Z",
      cwd: "/tmp/project",
      prompt: "review",
      status: "completed",
    });
    appendMessage(sessionId, { role: "assistant", content: [{ type: "text", text: "done" }] });

    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(2);
  });

  test("loadSubAgentRuns ignores legacy raw messages", () => {
    const sessionId = "session-raw-only";
    writeSessionHeader(sessionId, {
      provider: "mock",
      model: "mock",
      cwd: "/tmp/project",
    });
    appendMessage(sessionId, { role: "user", content: "hello" });

    expect(loadSubAgentRuns(sessionId)).toHaveLength(0);
  });

  test("loadSubAgentRuns returns display-friendly summaries in created order", () => {
    const sessionId = "session-display";
    writeSessionHeader(sessionId, {
      provider: "mock",
      model: "mock",
      cwd: "/tmp/project",
    });

    appendSubAgentRunRecord(sessionId, {
      childId: "child-late",
      sessionId,
      createdAt: "2026-04-16T00:00:02.000Z",
      cwd: "/tmp/project",
      providerName: "mock",
      model: "mock",
      prompt: "late child",
      usedTools: ["Bash"],
      summary: "Late child summary",
      finalText: "Late child final text",
      turns: 1,
      success: true,
      status: "completed",
      resultKind: "child",
    });
    appendSubAgentRunRecord(sessionId, {
      childId: "child-early",
      sessionId,
      createdAt: "2026-04-16T00:00:01.000Z",
      cwd: "/tmp/project",
      providerName: "mock",
      model: "mock",
      prompt: "early child",
      usedTools: ["FileRead"],
      summary: "Early child summary",
      finalText: "Early child final text",
      turns: 2,
      success: true,
      status: "completed",
      resultKind: "child",
    });

    const loaded = loadSubAgentRuns(sessionId);
    expect(loaded.map((record) => record.childId)).toEqual(["child-early", "child-late"]);
    expect(loaded[0]?.displayTitle).toContain("child-early");
    expect(loaded[0]?.displaySummary).toContain("child • completed");
    expect(loaded[0]?.displaySummary).toContain("Early child summary");
  });
});
