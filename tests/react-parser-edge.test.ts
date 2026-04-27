import { describe, expect, test } from "bun:test";
import { parseReactToolCall } from "../src/providers/openai-compatible.js";

const tools = new Set(["Bash", "Glob", "NoArgTool"]);

describe("parseReactToolCall edge cases", () => {
  test('parses the "tool_name" key', () => {
    const parsed = parseReactToolCall(
      '{"tool_name":"Bash","arguments":{"command":"pwd"}}',
      tools,
    );

    expect(parsed).toEqual({
      name: "Bash",
      args: { command: "pwd" },
    });
  });

  test("parses JSON inside ~~~ code fences", () => {
    const parsed = parseReactToolCall(
      '~~~json\n{"name":"Glob","arguments":{"pattern":"*.ts","path":"src"}}\n~~~',
      tools,
    );

    expect(parsed).toEqual({
      name: "Glob",
      args: { pattern: "*.ts", path: "src" },
    });
  });

  test("keeps explicit empty arguments objects", () => {
    const parsed = parseReactToolCall(
      '{"name":"NoArgTool","arguments":{}}',
      tools,
    );

    expect(parsed).toEqual({
      name: "NoArgTool",
      args: {},
    });
  });
});
