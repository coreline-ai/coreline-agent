/**
 * Phase B tests — tool edge cases + config fixes.
 */

import { describe, test, expect } from "bun:test";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { FileEditTool } from "../src/tools/file-edit/file-edit-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import { BashTool } from "../src/tools/bash/bash-tool.js";
import { GlobTool } from "../src/tools/glob/glob-tool.js";
import type { ToolUseContext } from "../src/tools/types.js";
import { writeFileSync, mkdtempSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeCtx(cwd?: string): ToolUseContext {
  return { cwd: cwd ?? process.cwd(), abortSignal: new AbortController().signal, nonInteractive: true };
}

// ---------------------------------------------------------------------------
// M2: FileRead image base64
// ---------------------------------------------------------------------------

describe("FileReadTool: image base64 (M2)", () => {
  test("PNG file returns base64 field", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cr-test-"));
    const pngPath = join(tmpDir, "test.png");
    // Minimal 1x1 PNG
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
      "Nl7BcQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(pngPath, pngData);

    const result = await FileReadTool.call({ file_path: pngPath }, makeCtx(tmpDir));
    expect(result.data.isImage).toBe(true);
    expect(result.data.base64).toBeDefined();
    expect(result.data.base64!.length).toBeGreaterThan(0);

    unlinkSync(pngPath);
  });

  test("text file has no base64 field", async () => {
    const result = await FileReadTool.call({ file_path: "package.json" }, makeCtx());
    expect(result.data.base64).toBeUndefined();
    expect(result.data.isImage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M3: FileEdit error distinction
// ---------------------------------------------------------------------------

describe("FileEditTool: error reasons (M3)", () => {
  let tmpDir: string;

  test("not_found when old_string missing", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cr-test-"));
    const f = join(tmpDir, "test.txt");
    writeFileSync(f, "hello world");

    const result = await FileEditTool.call(
      { file_path: f, old_string: "nonexistent", new_string: "x" },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("not_found");

    unlinkSync(f);
  });

  test("not_unique when multiple matches", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cr-test-"));
    const f = join(tmpDir, "dup.txt");
    writeFileSync(f, "aaa\naaa\naaa");

    const result = await FileEditTool.call(
      { file_path: f, old_string: "aaa", new_string: "bbb" },
      makeCtx(tmpDir),
    );
    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("not_unique");

    unlinkSync(f);
  });

  test("formatResult shows distinct messages", () => {
    const notFound = FileEditTool.formatResult(
      { filePath: "x.ts", replacements: 0, originalLength: 10, newLength: 10, errorReason: "not_found" },
      "id1",
    );
    expect(notFound).toContain("not found");

    const notUnique = FileEditTool.formatResult(
      { filePath: "x.ts", replacements: 0, originalLength: 10, newLength: 10, errorReason: "not_unique" },
      "id2",
    );
    expect(notUnique).toContain("multiple");
    expect(notUnique).toContain("replace_all");
  });
});

// ---------------------------------------------------------------------------
// Tool edge cases
// ---------------------------------------------------------------------------

describe("Tool edge cases", () => {
  test("FileRead: empty file returns empty content", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cr-test-"));
    const f = join(tmpDir, "empty.txt");
    writeFileSync(f, "");

    const result = await FileReadTool.call({ file_path: f }, makeCtx(tmpDir));
    expect(result.isError).toBeFalsy();
    expect(result.data.totalLines).toBe(1); // empty string splits to [""]

    unlinkSync(f);
  });

  test("Glob: nonexistent directory returns empty", async () => {
    const result = await GlobTool.call(
      { pattern: "*.ts", path: "/tmp/nonexistent_dir_xyz" },
      makeCtx(),
    );
    expect(result.data.numFiles).toBe(0);
  });

  test("Bash: command not found (exit 127)", async () => {
    const result = await BashTool.call(
      { command: "nonexistent_command_xyz_123" },
      makeCtx(),
    );
    expect(result.data.exitCode).toBe(127);
    expect(result.isError).toBe(true);
  });

  test("Bash: stderr only output", async () => {
    const result = await BashTool.call(
      { command: "ls /nonexistent_path_xyz 2>&1" },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  test("FileEdit: read_error on nonexistent file", async () => {
    const result = await FileEditTool.call(
      { file_path: "/tmp/nonexistent_file_xyz.txt", old_string: "a", new_string: "b" },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("read_error");
  });
});
