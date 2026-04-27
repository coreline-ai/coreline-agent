/**
 * Permission/UI tests — prompt copy and child-task status helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  getPermissionPromptDetails,
  isDelegatedWriteRequest,
} from "../src/tui/permission-prompt.js";
import {
  getToolDetailLine,
  parseAgentResult,
  type ToolCallDisplay,
} from "../src/tui/tool-result.js";

describe("Permission prompt copy", () => {
  test("marks delegated write children clearly", () => {
    expect(isDelegatedWriteRequest("Agent", {
      prompt: "write code",
      allowedTools: ["FileRead", "FileWrite"],
    })).toBe(true);

    const details = getPermissionPromptDetails(
      "Agent",
      { prompt: "write code", allowedTools: ["FileRead", "FileWrite"] },
      "Delegated child requested write-capable tools: FileWrite.",
    );

    expect(details.scopeLabel).toBe("Delegated child (write-capable)");
    expect(details.policyLabel?.toLowerCase()).toContain("non-interactive child runs deny write requests automatically");
    expect(details.reasonLabel).toContain("write-capable tools");
    expect(details.targetLabel).toContain("FileWrite");
  });

  test("keeps normal tools compact", () => {
    const details = getPermissionPromptDetails(
      "FileRead",
      { file_path: "src/index.ts" },
      "Read-only tool",
    );

    expect(details.scopeLabel).toBe("Tool request");
    expect(details.policyLabel).toBeUndefined();
    expect(details.summary).toBe("src/index.ts");
  });

  test("shows batch count for delegated child groups", () => {
    const details = getPermissionPromptDetails(
      "Agent",
      {
        prompt: "run two tasks",
        subtasks: [{ prompt: "one" }, { prompt: "two" }],
      },
      "Delegated child batch.",
    );

    expect(details.subtaskLabel).toBe("2 delegated child tasks");
  });
});

describe("Tool result child/status helpers", () => {
  test("parses Agent tool results into a compact summary", () => {
    const parsed = parseAgentResult([
      "AGENT_RESULT",
      "reason: completed",
      "turns: 2",
      "used_tools: FileRead, Bash",
      "summary: Reviewed package.json",
      "",
      "FINAL_TEXT_START",
      "Done.",
      "FINAL_TEXT_END",
    ].join("\n"));

    expect(parsed).not.toBeNull();
    expect(parsed?.reason).toBe("completed");
    expect(parsed?.turns).toBe(2);
    expect(parsed?.usedTools).toEqual(["FileRead", "Bash"]);
    expect(parsed?.summary).toBe("Reviewed package.json");
    expect(parsed?.finalText).toBe("Done.");
  });

  test("adds a child/approval detail line for Agent tool calls", () => {
    const toolCall: ToolCallDisplay = {
      toolUseId: "1",
      toolName: "Agent",
      input: { prompt: "review package.json" },
      result: [
        "AGENT_RESULT",
        "reason: completed",
        "turns: 1",
        "used_tools: FileRead",
        "summary: Reviewed package.json",
        "",
        "FINAL_TEXT_START",
        "Looks good.",
        "FINAL_TEXT_END",
      ].join("\n"),
      status: "done",
    };

    expect(getToolDetailLine(toolCall)).toBe("child | turns=1 | tools=FileRead | approval=completed");
  });

  test("shows coordinator counts in the detail line", () => {
    const toolCall: ToolCallDisplay = {
      toolUseId: "3",
      toolName: "Agent",
      input: { prompt: "run batch" },
      result: [
        "AGENT_RESULT",
        "reason: completed",
        "mode: coordinator",
        "status: partial",
        "turns: 3",
        "child_count: 2",
        "completed_count: 1",
        "failed_count: 1",
        "used_tools: FileRead, Bash",
        "summary: Batch completed with one failure",
        "",
        "FINAL_TEXT_START",
        "done",
        "FINAL_TEXT_END",
      ].join("\n"),
      status: "done",
    };

    expect(getToolDetailLine(toolCall)).toBe("coordinator | turns=3 | tools=FileRead, Bash | children=2 completed=1 failed=1 | approval=partial");
  });

  test("shows denied approval state for permission errors", () => {
    const toolCall: ToolCallDisplay = {
      toolUseId: "2",
      toolName: "FileWrite",
      input: { file_path: "/tmp/foo.txt" },
      result: "Permission denied in non-interactive mode for FileWrite",
      isError: true,
      status: "done",
    };

    expect(getToolDetailLine(toolCall)).toBe("approval=denied");
  });
});
