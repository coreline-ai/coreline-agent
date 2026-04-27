import { describe, expect, test } from "bun:test";
import { normalizeMessage } from "../src/session/transcript.js";

describe("transcript normalization", () => {
  test("user message becomes one transcript entry", () => {
    const entries = normalizeMessage(
      { role: "user", content: "hello world" },
      1,
      { sessionId: "session-a", timestamp: "2026-04-18T12:00:00.000Z" },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      _type: "transcript_entry",
      sessionId: "session-a",
      timestamp: "2026-04-18T12:00:00.000Z",
      role: "user",
      text: "hello world",
      turnIndex: 1,
    });
  });

  test("assistant text and tool_use split into separate entries", () => {
    const toolNames = new Map<string, string>();
    const entries = normalizeMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect this." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
      2,
      { sessionId: "session-a", timestamp: "2026-04-18T12:00:01.000Z", toolNameById: toolNames },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      role: "assistant",
      text: "I will inspect this.",
      turnIndex: 2,
    });
    expect(entries[1]).toMatchObject({
      role: "assistant",
      toolName: "Bash",
      toolUseId: "tool-1",
      text: "{\"command\":\"pwd\"}",
      turnIndex: 2,
    });
    expect(toolNames.get("tool-1")).toBe("Bash");
  });

  test("tool_result becomes a tool entry", () => {
    const toolNames = new Map<string, string>([["tool-2", "Glob"]]);
    const entries = normalizeMessage(
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "tool-2", content: "src/index.ts", isError: false }],
      },
      3,
      { sessionId: "session-a", timestamp: "2026-04-18T12:00:02.000Z", toolNameById: toolNames },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: "tool",
      toolName: "Glob",
      toolUseId: "tool-2",
      text: "src/index.ts",
      turnIndex: 3,
    });
  });

  test("turn index is preserved across multiple entries", () => {
    const entries = normalizeMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      9,
      { sessionId: "session-a", timestamp: "2026-04-18T12:00:03.000Z" },
    );

    expect(entries.map((entry) => entry.turnIndex)).toEqual([9, 9]);
  });
});

