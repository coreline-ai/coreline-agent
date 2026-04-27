import { describe, expect, test } from "bun:test";
import { ToolCallDedup, hashInput } from "../src/agent/tool-call-dedup.js";
import { ToolCallPatternGuard } from "../src/agent/tool-loop-guard.js";

describe("ToolCallDedup", () => {
  test("same tool + same input reaches duplicate state on the 4th consecutive record", () => {
    const dedup = new ToolCallDedup();
    const inputHash = hashInput({ command: "echo hi" });

    expect(dedup.record("Bash", inputHash)).toEqual({
      isDuplicate: false,
      consecutiveCount: 1,
    });
    expect(dedup.record("Bash", inputHash)).toEqual({
      isDuplicate: false,
      consecutiveCount: 2,
    });
    expect(dedup.record("Bash", inputHash)).toEqual({
      isDuplicate: false,
      consecutiveCount: 3,
    });
    expect(dedup.record("Bash", inputHash)).toEqual({
      isDuplicate: true,
      consecutiveCount: 4,
    });
  });

  test("same tool with different input produces distinct hashes and resets count", () => {
    const dedup = new ToolCallDedup();
    const first = hashInput({ command: "echo hi" });
    const second = hashInput({ command: "echo bye" });

    expect(first).not.toBe(second);
    expect(dedup.record("Bash", first).consecutiveCount).toBe(1);
    expect(dedup.record("Bash", second).consecutiveCount).toBe(1);
  });

  test("different tool in between resets consecutive tracking", () => {
    const dedup = new ToolCallDedup();
    const inputHash = hashInput({ pattern: "*.ts" });

    expect(dedup.record("Glob", inputHash).consecutiveCount).toBe(1);
    expect(dedup.record("Glob", inputHash).consecutiveCount).toBe(2);
    expect(dedup.record("Grep", inputHash).consecutiveCount).toBe(1);
    expect(dedup.record("Glob", inputHash).consecutiveCount).toBe(1);
  });

  test("reset clears the internal state", () => {
    const dedup = new ToolCallDedup();
    const inputHash = hashInput({ path: "src" });

    expect(dedup.record("Glob", inputHash).consecutiveCount).toBe(1);
    expect(dedup.record("Glob", inputHash).consecutiveCount).toBe(2);
    dedup.reset();
    expect(dedup.record("Glob", inputHash).consecutiveCount).toBe(1);
  });
});

describe("ToolCallPatternGuard", () => {
  test("allows a normal three-step chain once, then flags the repeated cycle", () => {
    const guard = new ToolCallPatternGuard();

    expect(guard.record("Glob")).toMatchObject({
      triggered: false,
      consecutiveCount: 1,
    });
    expect(guard.record("Grep")).toMatchObject({
      triggered: false,
      consecutiveCount: 1,
    });
    expect(guard.record("FileRead")).toMatchObject({
      triggered: false,
      consecutiveCount: 1,
    });

    expect(guard.record("Glob")).toMatchObject({
      triggered: false,
      consecutiveCount: 1,
    });
    expect(guard.record("Grep")).toMatchObject({
      triggered: false,
      consecutiveCount: 1,
    });

    const blocked = guard.record("FileRead");
    expect(blocked).toMatchObject({
      triggered: true,
      toolName: "FileRead",
      consecutiveCount: 2,
      threshold: 2,
      cycleLength: 3,
    });
    expect(blocked.message).toContain("repeating tool pattern");
    expect(blocked.message).toContain("Glob → Grep → FileRead");
  });

  test("does not flag repeated single-tool attempts as a short cycle", () => {
    const guard = new ToolCallPatternGuard();

    expect(guard.record("FileRead").triggered).toBe(false);
    expect(guard.record("FileRead").triggered).toBe(false);
    expect(guard.record("FileRead").triggered).toBe(false);
    expect(guard.record("FileRead").triggered).toBe(false);
  });
});
