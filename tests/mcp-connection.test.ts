/**
 * MCP connection manager tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  McpClientSession,
  McpConnectionManager,
  type McpTransport,
} from "../src/mcp/connection.js";
import type { McpConfigFile } from "../src/mcp/types.js";

class MemoryTransport implements McpTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public closed = false;

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });

    if (method === "initialize") {
      return {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "memory", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } },
      } as TResult;
    }

    if (method === "tools/list") {
      return {
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
      } as TResult;
    }

    if (method === "tools/call") {
      const text = ((params as { arguments?: { text?: string } })?.arguments?.text ?? "") as string;
      return {
        content: [{ type: "text", text: `echo:${text}` }],
        structuredContent: { echoed: text },
        isError: false,
      } as TResult;
    }

    if (method === "ping") {
      return {} as TResult;
    }

    throw new Error(`Unexpected request: ${method}`);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.requests.push({ method: `notify:${method}`, params });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createConfig(): McpConfigFile {
  return {
    defaultServer: "memory",
    servers: [
      {
        name: "memory",
        command: "bun",
        args: ["server.js"],
      },
    ],
  };
}

function makeServerScript(filePath: string): void {
  const protocolModule = pathToFileURL(join(process.cwd(), "src/mcp/protocol.ts")).href;
  writeFileSync(
    filePath,
    [
      `import { McpFrameParser, encodeJsonRpcMessage } from ${JSON.stringify(protocolModule)};`,
      "const parser = new McpFrameParser();",
      "function send(obj) { process.stdout.write(encodeJsonRpcMessage(obj)); }",
      "function handle(msg) {",
      "  if (msg.method === 'initialize') {",
      "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'mock-mcp', version: '1.0.0', title: 'Mock MCP' }, capabilities: { tools: { listChanged: false } } } });",
      "    return;",
      "  }",
      "  if (msg.method === 'notifications/initialized') return;",
      "  if (msg.method === 'tools/list') {",
      "    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [ { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } ] } });",
      "    return;",
      "  }",
      "  if (msg.method === 'tools/call') {",
      "    const text = msg.params?.arguments?.text ?? '';",
      "    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + text }], structuredContent: { echoed: text }, isError: false } });",
      "    return;",
      "  }",
      "  if (msg.method === 'ping') {",
      "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
      "    return;",
      "  }",
      "  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method ' + msg.method } });",
      "}",
      "process.stdin.on('data', (chunk) => {",
      "  for (const msg of parser.push(chunk)) {",
      "    handle(msg);",
      "  }",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join("\n"),
    "utf-8",
  );
}

describe("MCP connection manager", () => {
  test("connects, lists tools, and calls tools with a transport stub", async () => {
    const transport = new MemoryTransport();
    const config = createConfig();
    const manager = new McpConnectionManager(config, {
      transportFactory: () => transport,
      requestTimeoutMs: 1000,
    });

    const session = await manager.connect();
    expect(session).toBeInstanceOf(McpClientSession);
    expect(transport.requests[0]?.method).toBe("initialize");

    const statusBeforeTools = manager.getStatusSnapshot();
    expect(statusBeforeTools.selection.state).toBe("selected");
    expect(statusBeforeTools.servers[0]?.state).toBe("ready");
    expect(statusBeforeTools.servers[0]?.transport).toMatchObject({
      kind: "custom",
    });

    const tools = await manager.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      serverName: "memory",
      name: "echo",
      qualifiedName: "memory:echo",
      description: "Echo text",
    });

    const result = await manager.callTool("memory", "echo", { text: "hello" });
    expect(result.text).toContain("echo:hello");
    expect(result.result.isError).toBe(false);

    const statusAfterTools = manager.getStatusSnapshot();
    expect(statusAfterTools.servers[0]?.toolCount).toBe(1);
    expect(statusAfterTools.servers[0]?.lastToolRefreshAt).toBeDefined();

    await manager.close();
    expect(transport.closed).toBe(true);
  });

  test("connects to a real stdio MCP server and exercises the call path", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "coreline-mcp-server-"));
    try {
      const serverScript = join(tmpDir, "server.ts");
      makeServerScript(serverScript);

      const manager = new McpConnectionManager(
        {
          defaultServer: "mock",
          servers: [
            {
              name: "mock",
              command: "bun",
              args: [serverScript],
              timeoutMs: 5000,
            },
          ],
        },
        {
          requestTimeoutMs: 3000,
          shutdownTimeoutMs: 1000,
        },
      );

      const tools = await manager.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        serverName: "mock",
        name: "echo",
      });

      const result = await manager.callTool("mock", "echo", { text: "world" });
      expect(result.text).toContain("echo:world");
      expect(result.result.structuredContent).toEqual({ echoed: "world" });

      const status = manager.getStatusSnapshot();
      expect(status.selection.state).toBe("selected");
      expect(status.servers[0]?.serverInfo?.title).toBe("Mock MCP");
      expect(status.servers[0]?.transport?.kind).toBe("stdio");

      await manager.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back from a disabled default server", () => {
    const manager = new McpConnectionManager({
      defaultServer: "disabled",
      servers: [
        {
          name: "disabled",
          command: "bun",
          enabled: false,
        },
        {
          name: "active",
          command: "bun",
        },
      ],
    });

    expect(manager.getDefaultServerName()).toBe("active");
    const status = manager.getStatusSnapshot();
    expect(status.selection.state).toBe("fallback");
    expect(status.selection.selectedServerName).toBe("active");
    expect(status.selection.reason).toContain("disabled");
  });
});
