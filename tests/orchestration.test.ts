/**
 * Phase C — orchestration partitioning unit tests.
 */

import { describe, test, expect } from "bun:test";
import { runToolCalls } from "../src/tools/orchestration.js";
import { buildTool } from "../src/tools/types.js";
import type { ToolUseContext } from "../src/tools/types.js";
import type { ToolUseBlock } from "../src/agent/types.js";
import { z } from "zod";

// Mock tools
const ReadTool = buildTool({
  name: "ReadMock",
  description: "read",
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call() { return { data: "read-result" }; },
  formatResult(output) { return String(output); },
});

const WriteTool = buildTool({
  name: "WriteMock",
  description: "write",
  inputSchema: z.object({}),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call() { return { data: "write-result" }; },
  formatResult(output) { return String(output); },
});

const StrictTool = buildTool({
  name: "StrictMock",
  description: "requires a valid command field",
  inputSchema: z.object({ command: z.string() }),
  isReadOnly: (input) => input.command.trim().length > 0,
  isConcurrencySafe: (input) => input.command.trim().length > 0,
  async call(input) { return { data: input.command }; },
  formatResult(output) { return String(output); },
});

const ctx: ToolUseContext = {
  cwd: "/tmp",
  abortSignal: new AbortController().signal,
  nonInteractive: true,
};

async function collect(blocks: ToolUseBlock[], tools: Map<string, any>) {
  const results = [];
  for await (const r of runToolCalls(blocks, tools, ctx)) {
    results.push(r);
  }
  return results;
}

describe("Tool Orchestration", () => {
  test("read-only tools execute (parallel group)", async () => {
    const tools = new Map([["ReadMock", ReadTool]]);
    const blocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "ReadMock", input: {} },
      { type: "tool_use", id: "t2", name: "ReadMock", input: {} },
      { type: "tool_use", id: "t3", name: "ReadMock", input: {} },
    ];
    const results = await collect(blocks, tools);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.formattedResult === "read-result")).toBe(true);
  });

  test("write tools execute serially", async () => {
    const tools = new Map([["WriteMock", WriteTool]]);
    const blocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "WriteMock", input: {} },
      { type: "tool_use", id: "t2", name: "WriteMock", input: {} },
    ];
    const results = await collect(blocks, tools);
    expect(results).toHaveLength(2);
  });

  test("mixed read/write partition correctly", async () => {
    const tools = new Map<string, any>([
      ["ReadMock", ReadTool],
      ["WriteMock", WriteTool],
    ]);
    const blocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "ReadMock", input: {} },
      { type: "tool_use", id: "t2", name: "ReadMock", input: {} },
      { type: "tool_use", id: "t3", name: "WriteMock", input: {} },
      { type: "tool_use", id: "t4", name: "ReadMock", input: {} },
    ];
    const results = await collect(blocks, tools);
    expect(results).toHaveLength(4);
  });

  test("unknown tool returns error", async () => {
    const tools = new Map<string, any>();
    const blocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Unknown", input: {} },
    ];
    const results = await collect(blocks, tools);
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.formattedResult).toContain("Unknown tool");
  });

  test("empty blocks returns nothing", async () => {
    const results = await collect([], new Map());
    expect(results).toHaveLength(0);
  });

  test("invalid input fails validation before concurrency checks", async () => {
    const tools = new Map<string, any>([["StrictMock", StrictTool]]);
    const blocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "StrictMock", input: { "command:": "ls -la src" } },
    ];

    const results = await collect(blocks, tools);
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.formattedResult).toContain("Input validation error");
  });
});
