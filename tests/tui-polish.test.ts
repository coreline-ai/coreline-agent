/**
 * TUI polish tests — focused helper coverage for prompt/input/result formatting.
 */

import { describe, test, expect } from "bun:test";
import { formatPromptDisplayText, isPromptSubmitKey } from "../src/tui/prompt-input.js";
import { formatStreamingLines } from "../src/tui/streaming-output.js";
import {
  formatProviderModelLabel,
  formatQuotaStatusLabel,
  formatReasoningEffortLabel,
} from "../src/tui/status-bar.js";
import {
  getToolStatusLabel,
  summarizeInput,
  truncateResult,
  type ToolCallDisplay,
} from "../src/tui/tool-result.js";
import { validateStatuslineCommand } from "../src/agent/statusline.js";

describe("PromptInput helpers", () => {
  test("Enter submits, Shift+Enter does not", () => {
    expect(isPromptSubmitKey({ return: true })).toBe(true);
    expect(isPromptSubmitKey({ return: true, shift: true })).toBe(false);
  });

  test("display text includes cursor and placeholder", () => {
    expect(formatPromptDisplayText("", "Message...")).toBe("Message...▊");
    expect(formatPromptDisplayText("hello\nworld", "Message...")).toBe("hello\nworld▊");
  });
});

describe("StreamingOutput helpers", () => {
  test("keeps short streams intact", () => {
    expect(formatStreamingLines("a\nb\nc", 5)).toEqual({
      lines: ["a", "b", "c"],
      truncated: false,
    });
  });

  test("truncates to latest lines for long streams", () => {
    expect(formatStreamingLines("1\n2\n3\n4\n5", 3)).toEqual({
      lines: ["3", "4", "5"],
      truncated: true,
    });
  });
});

describe("ToolResult helpers", () => {
  test("summarizes common tool inputs", () => {
    expect(summarizeInput("Bash", { command: "echo hello" })).toBe("echo hello");
    expect(summarizeInput("FileRead", { file_path: "src/index.ts" })).toBe("src/index.ts");
    expect(summarizeInput("Glob", { pattern: "*.ts", path: "src" })).toBe("*.ts in src");
    expect(summarizeInput("Grep", { pattern: "foo", path: "src" })).toBe("/foo/ in src");
  });

  test("truncates multi-line results", () => {
    expect(truncateResult("a\nb\nc\nd", 2)).toContain("more lines");
  });

  test("status label is stable", () => {
    const running: ToolCallDisplay = {
      toolUseId: "1",
      toolName: "Bash",
      input: { command: "ls" },
      status: "running",
    };
    const failed: ToolCallDisplay = {
      toolUseId: "2",
      toolName: "Bash",
      input: { command: "ls" },
      result: "nope",
      isError: true,
      status: "done",
    };
    const done: ToolCallDisplay = {
      toolUseId: "3",
      toolName: "Bash",
      input: { command: "ls" },
      result: "ok",
      status: "done",
    };

    expect(getToolStatusLabel(running)).toBe("running");
    expect(getToolStatusLabel(failed)).toBe("failed");
    expect(getToolStatusLabel(done)).toBe("done");
  });
});

describe("StatusBar helpers", () => {
  test("normalizes provider/model/reasoning labels compactly", () => {
    expect(formatProviderModelLabel({
      providerName: "codex",
      providerType: "codex-backend",
      model: "gpt-5-codex",
    })).toEqual({ provider: "codex", model: "GPT-5 Codex" });
    expect(formatProviderModelLabel({
      providerName: "claude",
      providerType: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    }).model).toBe("Claude 3.5 Sonnet");
    expect(formatReasoningEffortLabel("high")).toBe("r:high");
  });

  test("formats quota and rate-limit metadata when present", () => {
    expect(formatQuotaStatusLabel({ remaining: 42, limit: 100 })).toBe("quota:42/100");
    expect(formatQuotaStatusLabel(undefined, { remainingRequests: 9, limitRequests: 10 })).toBe("rl:9/10r");
  });

  test("statusline command helper previews without executing commands", () => {
    const safe = validateStatuslineCommand("git status --short");
    expect(safe.valid).toBe(true);
    expect(safe.wouldExecute).toBe(false);
    expect(safe.preview).toBe("git status --short");

    const dangerous = validateStatuslineCommand("rm -rf /tmp/coreline-statusline-test");
    expect(dangerous.wouldExecute).toBe(false);
    expect(dangerous.risk).not.toBe("safe");
  });
});
