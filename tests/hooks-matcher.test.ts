import { describe, expect, test } from "bun:test";
import { matchesHook, matchesIfExpression, matchesPattern, parseIfExpression } from "../src/hooks/index.js";
import type { HookConfig, PreToolHookInput } from "../src/hooks/index.js";

const input: PreToolHookInput = {
  event: "PreTool",
  toolName: "Bash",
  input: { command: "git status --short" },
};

function hook(config: Partial<HookConfig>): HookConfig {
  return {
    type: "function",
    event: "PreTool",
    handler: () => undefined,
    ...config,
  } as HookConfig;
}

describe("hook matchers", () => {
  test("rejects event mismatch", () => {
    expect(matchesHook(hook({ event: "StatusChange" }), input)).toBe(false);
  });

  test("matches exact, contains, and wildcard patterns", () => {
    expect(matchesPattern("git status", "git status")).toBe(true);
    expect(matchesPattern("git status --short", "status")).toBe(true);
    expect(matchesPattern("git status --short", "git *")).toBe(true);
    expect(matchesPattern("npm test", "git *")).toBe(false);
  });

  test("matches if expressions against tool and action", () => {
    expect(matchesIfExpression("Bash(git *)", input)).toBe(true);
    expect(matchesIfExpression("Bash(npm *)", input)).toBe(false);
    expect(matchesIfExpression("FileRead(*)", input)).toBe(false);
  });

  test("malformed if expressions do not match", () => {
    expect(parseIfExpression("Bash git *)")).toBeNull();
    expect(matchesIfExpression("Bash git *)", input)).toBe(false);
  });

  test("matches full hook config", () => {
    expect(matchesHook(hook({ matcher: "git *", if: "Bash(git *)" }), input)).toBe(true);
    expect(matchesHook(hook({ matcher: "npm *", if: "Bash(git *)" }), input)).toBe(false);
  });
});
