import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/paths.js";
import { searchTranscripts } from "../src/session/search.js";

describe("transcript search", () => {
  let tmpDir: string;
  let originalSessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-transcript-search-"));
    originalSessionsDir = paths.sessionsDir;
    (paths as { sessionsDir: string }).sessionsDir = tmpDir;
  });

  afterEach(() => {
    (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("search finds normalized legacy messages and transcript entries", () => {
    writeFileSync(
      join(tmpDir, "session-a.jsonl"),
      [
        JSON.stringify({ role: "user", content: "hello world" }),
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-a", timestamp: "2026-04-18T12:00:01.000Z", role: "assistant", text: "needle here", turnIndex: 1 }),
      ].join("\n") + "\n",
      "utf-8",
    );

    writeFileSync(
      join(tmpDir, "session-b.jsonl"),
      [
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "another match" }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }] }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const helloResults = searchTranscripts("hello", { sessionsDir: tmpDir });
    expect(helloResults).toHaveLength(1);
    expect(helloResults[0]).toMatchObject({
      sessionId: "session-a",
      role: "user",
      text: "hello world",
    });

    const needleResults = searchTranscripts("needle", { sessionsDir: tmpDir });
    expect(needleResults).toHaveLength(1);
    expect(needleResults[0]).toMatchObject({
      sessionId: "session-a",
      role: "assistant",
      text: "needle here",
    });
  });

  test("search respects role, toolName, before/after and limit", () => {
    writeFileSync(
      join(tmpDir, "session-c.jsonl"),
      [
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-c", timestamp: "2026-04-18T12:00:00.000Z", role: "tool", toolName: "Bash", toolUseId: "tool-1", text: "pwd", turnIndex: 1 }),
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-c", timestamp: "2026-04-18T12:10:00.000Z", role: "assistant", toolName: "Bash", toolUseId: "tool-1", text: "{\"command\":\"pwd\"}", turnIndex: 1 }),
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-c", timestamp: "2026-04-18T12:20:00.000Z", role: "user", text: "hello again", turnIndex: 2 }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const filtered = searchTranscripts("pwd", {
      sessionsDir: tmpDir,
      role: "tool",
      toolName: "Bash",
      after: "2026-04-18T11:59:59.000Z",
      before: "2026-04-18T12:00:59.000Z",
      limit: 1,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      sessionId: "session-c",
      role: "tool",
      toolName: "Bash",
      text: "pwd",
    });
  });

  test("search returns empty array when nothing matches", () => {
    writeFileSync(join(tmpDir, "session-empty.jsonl"), JSON.stringify({ role: "user", content: "no match" }) + "\n", "utf-8");

    expect(searchTranscripts("missing", { sessionsDir: tmpDir })).toEqual([]);
  });
});

