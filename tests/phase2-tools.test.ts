/**
 * Phase 2 smoke tests — tool system.
 */

import { describe, test, expect } from "bun:test";
import { ToolRegistryImpl } from "../src/tools/registry.js";
import { GlobTool } from "../src/tools/glob/glob-tool.js";
import { GrepTool } from "../src/tools/grep/grep-tool.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import { FileEditTool } from "../src/tools/file-edit/file-edit-tool.js";
import { BashTool } from "../src/tools/bash/bash-tool.js";
import type { ToolUseContext } from "../src/tools/types.js";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeContext(cwd?: string): ToolUseContext {
  return {
    cwd: cwd ?? process.cwd(),
    abortSignal: new AbortController().signal,
    nonInteractive: true,
  };
}

describe("ToolRegistry", () => {
  test("register and lookup tools", () => {
    const registry = new ToolRegistryImpl();
    registry.register(GlobTool);
    registry.register(BashTool);

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getByName("Glob")).toBe(GlobTool);
    expect(registry.getByName("Bash")).toBe(BashTool);
    expect(registry.getByName("Unknown")).toBeUndefined();
  });

  test("getToolDefinitions returns JSON Schema", async () => {
    const registry = new ToolRegistryImpl();
    registry.register(GlobTool);

    const defs = await registry.getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("Glob");
    expect(defs[0]!.inputSchema).toBeDefined();
  });

  test("duplicate registration throws", () => {
    const registry = new ToolRegistryImpl();
    registry.register(GlobTool);
    expect(() => registry.register(GlobTool)).toThrow("already registered");
  });
});

describe("GlobTool", () => {
  test("finds TypeScript files", async () => {
    const ctx = makeContext();
    const result = await GlobTool.call({ pattern: "src/**/*.ts" }, ctx);
    expect(result.data.numFiles).toBeGreaterThan(0);
    expect(result.data.filenames.some((f: string) => f.endsWith(".ts"))).toBe(true);
  });

  test("returns empty for no matches", async () => {
    const ctx = makeContext();
    const result = await GlobTool.call({ pattern: "**/*.nonexistent_xyz" }, ctx);
    expect(result.data.numFiles).toBe(0);
  });

  test("retries recursively for bare extension patterns like *.ts", async () => {
    const ctx = makeContext();
    const result = await GlobTool.call({ pattern: "*.ts", path: "src" }, ctx);
    expect(result.data.numFiles).toBeGreaterThan(0);
    expect(result.data.filenames.some((f: string) => f.endsWith(".ts"))).toBe(true);
  });

  test("is read-only and concurrency-safe", () => {
    expect(GlobTool.isReadOnly({})).toBe(true);
    expect(GlobTool.isConcurrencySafe({})).toBe(true);
  });
});

describe("FileReadTool", () => {
  test("reads package.json with line numbers", async () => {
    const ctx = makeContext();
    const result = await FileReadTool.call({ file_path: "package.json" }, ctx);
    expect(result.data.content).toContain("coreline-agent");
    expect(result.data.totalLines).toBeGreaterThan(0);
    expect(result.isError).toBeFalsy();
  });

  test("reads with offset and limit", async () => {
    const ctx = makeContext();
    const result = await FileReadTool.call({ file_path: "package.json", offset: 1, limit: 3 }, ctx);
    expect(result.data.displayedLines).toBe(3);
  });

  test("errors on nonexistent file", async () => {
    const ctx = makeContext();
    const result = await FileReadTool.call({ file_path: "/nonexistent/file.txt" }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe("FileWriteTool + FileEditTool", () => {
  let tmpDir: string;

  test("write and edit a file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coreline-test-"));
    const filePath = join(tmpDir, "test.txt");
    const ctx = makeContext(tmpDir);

    // Write
    const writeResult = await FileWriteTool.call(
      { file_path: filePath, content: "hello world\nfoo bar\n" },
      ctx,
    );
    expect(writeResult.data.bytesWritten).toBeGreaterThan(0);

    // Edit (unique match)
    const editResult = await FileEditTool.call(
      { file_path: filePath, old_string: "foo bar", new_string: "baz qux" },
      ctx,
    );
    expect(editResult.data.replacements).toBe(1);

    // Read back
    const readResult = await FileReadTool.call({ file_path: filePath }, ctx);
    expect(readResult.data.content).toContain("baz qux");
    expect(readResult.data.content).not.toContain("foo bar");

    // Cleanup
    await unlink(filePath);
  });

  test("edit fails on non-unique match", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coreline-test-"));
    const filePath = join(tmpDir, "dup.txt");
    const ctx = makeContext(tmpDir);

    await FileWriteTool.call(
      { file_path: filePath, content: "aaa\naaa\n" },
      ctx,
    );

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "aaa", new_string: "bbb" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.data.replacements).toBe(0);

    await unlink(filePath);
  });
});

describe("BashTool", () => {
  test("executes echo command", async () => {
    const ctx = makeContext();
    const result = await BashTool.call({ command: "echo hello" }, ctx);
    expect(result.data.stdout).toBe("hello");
    expect(result.data.exitCode).toBe(0);
  });

  test("captures exit code on failure", async () => {
    const ctx = makeContext();
    const result = await BashTool.call({ command: "exit 42" }, ctx);
    expect(result.data.exitCode).toBe(42);
    expect(result.isError).toBe(true);
  });

  test("times out on long commands", async () => {
    const ctx = makeContext();
    const result = await BashTool.call({ command: "sleep 60", timeout: 500 }, ctx);
    expect(result.data.timedOut).toBe(true);
  });

  test("is read-only for safe commands", () => {
    expect(BashTool.isReadOnly({ command: "ls -la" })).toBe(true);
    expect(BashTool.isReadOnly({ command: "rm -rf /" })).toBe(false);
  });
});

describe("GrepTool", () => {
  test("finds pattern in source files", async () => {
    const ctx = makeContext();
    const result = await GrepTool.call({ pattern: "buildTool", path: "src/" }, ctx);
    expect(result.data.numMatches).toBeGreaterThan(0);
  });
});
