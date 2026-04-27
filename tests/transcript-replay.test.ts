import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/paths.js";
import { replaySession } from "../src/session/replay.js";
import { SessionManager } from "../src/session/history.js";
import { loadSession } from "../src/session/storage.js";

describe("transcript replay", () => {
  let tmpDir: string;
  let originalSessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-transcript-replay-"));
    originalSessionsDir = paths.sessionsDir;
    (paths as { sessionsDir: string }).sessionsDir = tmpDir;
  });

  afterEach(() => {
    (paths as { sessionsDir: string }).sessionsDir = originalSessionsDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("replaySession produces a compact time-ordered summary", () => {
    writeFileSync(
      join(tmpDir, "session-r1.jsonl"),
      [
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-r1", timestamp: "2026-04-18T09:00:00.000Z", role: "user", text: "hello", turnIndex: 1 }),
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-r1", timestamp: "2026-04-18T09:00:01.000Z", role: "assistant", text: "hi there", turnIndex: 1 }),
        JSON.stringify({ _type: "transcript_entry", sessionId: "session-r1", timestamp: "2026-04-18T09:00:02.000Z", role: "tool", toolName: "Bash", toolUseId: "tool-1", text: "/tmp", turnIndex: 1 }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const replay = replaySession("session-r1", { sessionsDir: tmpDir });
    expect(replay).toContain("[09:00] user: hello");
    expect(replay).toContain("[09:00] assistant: hi there");
    expect(replay).toContain("[09:00] tool(Bash): /tmp");
  });

  test("replaySession returns empty string for empty or missing session", () => {
    writeFileSync(join(tmpDir, "session-empty.jsonl"), "\n", "utf-8");

    expect(replaySession("session-empty", { sessionsDir: tmpDir })).toBe("");
    expect(replaySession("session-missing", { sessionsDir: tmpDir })).toBe("");
  });

  test("SessionManager persists normalized transcript entries alongside messages", () => {
    const session = new SessionManager({ providerName: "mock", model: "mock-model" });
    session.saveMessage({ role: "user", content: "please inspect src" });
    session.saveMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "tool-1", name: "Glob", input: { pattern: "src/**/*" } },
      ],
    });
    session.saveMessage({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "tool-1", content: "src/index.ts" }],
    });

    const replay = replaySession(session.sessionId, { sessionsDir: tmpDir });
    expect(replay).toContain("user: please inspect src");
    expect(replay).toContain("assistant: I will inspect it.");
    expect(replay).toContain("tool(Glob): src/index.ts");
    expect(loadSession(session.sessionId)?.messages).toHaveLength(3);
  });
});
