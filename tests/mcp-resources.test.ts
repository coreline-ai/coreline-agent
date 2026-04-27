/**
 * MCP resources + tool result storage tests.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  McpClientSession,
  McpConnectionManager,
} from "../src/mcp/connection.js";
import type { McpConfigFile, McpTransport } from "../src/mcp/types.js";
import { getProjectId } from "../src/memory/project-id.js";
import {
  EMPTY_TOOL_RESULT_MARKER,
  storeToolResultSync,
} from "../src/tools/result-storage.js";
import {
  createListMcpResourcesTool,
  createReadMcpResourceTool,
} from "../src/tools/mcp-resources/index.js";
import type { ToolUseContext } from "../src/tools/types.js";

class ResourceTransport implements McpTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  public closed = false;

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });

    if (method === "initialize") {
      return {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "resource-memory", version: "1.0.0", title: "Resource Memory" },
        capabilities: { resources: { listChanged: false } },
      } as TResult;
    }

    if (method === "resources/list") {
      return {
        resources: [
          {
            uri: "mock://text",
            name: "Text resource",
            description: "A text resource",
            mimeType: "text/plain",
            size: 13,
          },
          {
            uri: "mock://blob",
            name: "Blob resource",
            mimeType: "application/octet-stream",
            size: 4,
          },
        ],
      } as TResult;
    }

    if (method === "resources/read") {
      const uri = (params as { uri?: string } | undefined)?.uri;
      if (uri === "mock://text") {
        return {
          contents: [{ uri, mimeType: "text/plain", text: "hello resource" }],
        } as TResult;
      }
      if (uri === "mock://blob") {
        return {
          contents: [
            {
              uri,
              mimeType: "application/octet-stream",
              blob: Buffer.from([0, 1, 2, 3]).toString("base64"),
            },
          ],
        } as TResult;
      }
      return { contents: [] } as TResult;
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
    defaultServer: "mock",
    servers: [{ name: "mock", command: "bun" }],
  };
}

function makeContext(cwd: string): ToolUseContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    nonInteractive: true,
  };
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("tool result storage", () => {
  test("stores an empty tool result marker in a traversal-safe filename", () => {
    const rootDir = makeTempDir("coreline-result-root-");
    const cwd = makeTempDir("coreline-result-cwd-");
    try {
      const stored = storeToolResultSync(
        {
          toolUseId: "../evil/tool-id",
          toolName: "TestTool",
          content: "",
        },
        { cwd, rootDir },
      );

      expect(stored.isEmpty).toBe(true);
      expect(stored.preview).toBe(EMPTY_TOOL_RESULT_MARKER);
      expect(stored.previewMessage).toContain("empty-result marker");
      expect(existsSync(stored.filePath)).toBe(true);
      expect(readFileSync(stored.filePath, "utf8")).toContain(EMPTY_TOOL_RESULT_MARKER);
      expect(stored.directory).toBe(join(rootDir, "projects", getProjectId(cwd), "tool-results"));
      expect(basename(stored.filePath)).not.toContain("..");
      expect(basename(stored.filePath)).not.toContain("/");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("generates a bounded text preview for stored results", () => {
    const baseDir = makeTempDir("coreline-result-base-");
    try {
      const stored = storeToolResultSync(
        {
          toolUseId: "tool-preview",
          toolName: "TestTool",
          content: "abcdefghijklmnopqrstuvwxyz",
          mimeType: "text/plain",
        },
        { cwd: baseDir, baseDir, previewChars: 5 },
      );

      expect(stored.preview).toBe("abcde\n[preview truncated: showing 5 of 26 chars]");
      expect(stored.previewMessage).toContain("Tool result saved to:");
      expect(stored.previewMessage).toContain("Preview:\nabcde");
      expect(readFileSync(stored.filePath, "utf8")).toBe("abcdefghijklmnopqrstuvwxyz");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("MCP resource session APIs", () => {
  test("sends resources/list and resources/read JSON-RPC requests", async () => {
    const transport = new ResourceTransport();
    const session = new McpClientSession(createConfig().servers[0]!, {
      transport,
      requestTimeoutMs: 1000,
    });

    const resources = await session.listResources();
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      serverName: "mock",
      serverTitle: "Resource Memory",
      uri: "mock://text",
      qualifiedUri: "mock:mock://text",
    });

    const read = await session.readResource("mock://text");
    expect(read.text).toContain("hello resource");
    expect(read.result.contents[0]).toMatchObject({ uri: "mock://text", text: "hello resource" });

    expect(transport.requests.map((request) => request.method)).toContain("resources/list");
    expect(transport.requests.map((request) => request.method)).toContain("resources/read");
    await session.close();
  });
});

describe("MCP resource tools", () => {
  test("ListMcpResourcesTool is read-only/concurrency-safe and formats resources", async () => {
    const transport = new ResourceTransport();
    const manager = new McpConnectionManager(createConfig(), {
      transportFactory: () => transport,
      requestTimeoutMs: 1000,
    });
    const tool = createListMcpResourcesTool({ manager });

    expect(tool.isReadOnly({})).toBe(true);
    expect(tool.isConcurrencySafe({})).toBe(true);

    const result = await tool.call({}, makeContext(process.cwd()));
    expect(result.isError).toBeFalsy();
    expect(result.data.count).toBe(2);
    expect(tool.formatResult(result.data, "list-1")).toContain("mock://text");

    await manager.close();
  });

  test("ReadMcpResourceTool returns text resources directly", async () => {
    const transport = new ResourceTransport();
    const manager = new McpConnectionManager(createConfig(), {
      transportFactory: () => transport,
      requestTimeoutMs: 1000,
    });
    const tool = createReadMcpResourceTool({ manager });

    expect(tool.isReadOnly({ uri: "mock://text" })).toBe(true);
    expect(tool.isConcurrencySafe({ uri: "mock://text" })).toBe(true);

    const result = await tool.call({ uri: "mock://text" }, makeContext(process.cwd()));
    expect(result.isError).toBeFalsy();

    const formatted = tool.formatResult(result.data, "read-text-1");
    expect(formatted).toContain("hello resource");
    expect(formatted).not.toContain("Tool result saved to:");

    await manager.close();
  });

  test("ReadMcpResourceTool stores blob resources through result storage", async () => {
    const storageRoot = makeTempDir("coreline-mcp-blob-root-");
    const cwd = makeTempDir("coreline-mcp-blob-cwd-");
    const transport = new ResourceTransport();
    const manager = new McpConnectionManager(createConfig(), {
      transportFactory: () => transport,
      requestTimeoutMs: 1000,
    });
    const tool = createReadMcpResourceTool({ manager, storage: { rootDir: storageRoot } });

    try {
      const result = await tool.call({ uri: "mock://blob" }, makeContext(cwd));
      expect(result.isError).toBeFalsy();

      const formatted = tool.formatResult(result.data, "../blob/read");
      expect(formatted).toContain("Blob resource saved for mock://blob");
      expect(formatted).toContain("Tool result saved to:");
      expect(formatted).toContain("[binary data: 4 bytes, application/octet-stream]");

      const savedPath = formatted.match(/Tool result saved to: (.+)/)?.[1];
      expect(savedPath).toBeDefined();
      expect(existsSync(savedPath!)).toBe(true);
      expect([...readFileSync(savedPath!)]).toEqual([0, 1, 2, 3]);
      expect(basename(savedPath!)).not.toContain("..");
    } finally {
      await manager.close();
      rmSync(storageRoot, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
