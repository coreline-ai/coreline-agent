/**
 * MCP tool bridge tests.
 */

import { describe, expect, test } from "bun:test";
import { createMcpToolBridgeToolsFromInventory, mapMcpInventoryEntriesToToolDefinitions } from "../src/tools/mcp/bridge.js";
import type { McpToolInventoryEntry } from "../src/mcp/types.js";

function createInventory(): McpToolInventoryEntry[] {
  return [
    {
      serverName: "mock",
      serverTitle: "Mock MCP",
      qualifiedName: "mock:echo",
      name: "echo",
      description: "Echo text",
      title: "Echo Tool",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
  ];
}

describe("MCP bridge", () => {
  test("maps inventory to provider tool definitions", () => {
    const defs = mapMcpInventoryEntriesToToolDefinitions(createInventory());
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      name: "mock:echo",
      description: "Echo Tool — Echo text",
    });
  });

  test("creates executable tools from MCP inventory", async () => {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const tools = await createMcpToolBridgeToolsFromInventory(
      createInventory(),
      async (toolName, input) => {
        calls.push({ toolName, input });
        return {
          result: {
            content: [{ type: "text", text: `echo:${String((input as { text?: string }).text ?? "")}` }],
            isError: false,
          },
          text: `echo:${String((input as { text?: string }).text ?? "")}`,
        };
      },
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("mock:echo");
    expect(tools[0]!.isReadOnly({ text: "hello" } as never)).toBe(true);

    const result = await tools[0]!.call({ text: "hello" } as never, {
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      nonInteractive: true,
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ toolName: "echo", input: { text: "hello" } }]);
    expect(tools[0]!.formatResult(result.data as never, "tool-1")).toContain("echo:hello");
  });

  test("treats readable MCP tool names as read-only even without annotations", async () => {
    const tools = await createMcpToolBridgeToolsFromInventory(
      [
        {
          serverName: "mock",
          qualifiedName: "mock:listPages",
          name: "listPages",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      async () => ({
        result: { content: [], isError: false },
        text: "",
      }),
    );

    expect(tools[0]!.isReadOnly({} as never)).toBe(true);
    expect(tools[0]!.isConcurrencySafe({} as never)).toBe(true);
    expect(tools[0]!.checkPermissions({} as never, {
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      nonInteractive: true,
    }).behavior).toBe("allow");
  });

  test("rejects duplicate bridged tool names", async () => {
    await expect(
      createMcpToolBridgeToolsFromInventory(
        [
          {
            serverName: "a",
            qualifiedName: "a:echo",
            name: "echo",
            inputSchema: { type: "object", properties: {} },
          },
          {
            serverName: "b",
            qualifiedName: "b:echo",
            name: "echo",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        async () => ({
          result: { content: [], isError: false },
          text: "",
        }),
        { namespace: "shared" },
      ),
    ).rejects.toThrow(/collision/i);
  });
});
