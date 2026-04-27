import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCache } from "../src/agent/tool-cache.js";
import { MAX_EDIT_FILE_SIZE } from "../src/tools/file-edit/edit-utils.js";
import { FileEditTool } from "../src/tools/file-edit/file-edit-tool.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { checkFileReadPathSafety } from "../src/tools/file-read/read-safety.js";
import type { ToolUseContext } from "../src/tools/types.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-file-tools-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(cwd?: string, extra: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    cwd: cwd ?? process.cwd(),
    abortSignal: new AbortController().signal,
    nonInteractive: true,
    readFileState: new Map(),
    ...extra,
  };
}

async function readBeforeEdit(ctx: ToolUseContext, filePath: string, input: { offset?: number; limit?: number } = {}) {
  const result = await FileReadTool.call({ file_path: filePath, ...input }, ctx);
  expect(result.isError).toBeUndefined();
  return result;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FileReadTool blocked device paths", () => {
  test("blocks /dev device reads before ToolCache getOrSet", async () => {
    const throwingCache = {
      getOrSet: async () => {
        throw new Error("ToolCache should not be called for blocked paths");
      },
    } as unknown as ToolCache;

    const result = await FileReadTool.call(
      { file_path: "/dev/zero" },
      makeCtx(undefined, { toolCache: throwingCache }),
    );

    expect(result.isError).toBe(true);
    expect(result.data.content).toContain("blocked");
  });

  test("blocks stdio fd aliases", async () => {
    const devFd = await FileReadTool.call({ file_path: "/dev/fd/0" }, makeCtx());
    const procFd = await FileReadTool.call({ file_path: "/proc/self/fd/0" }, makeCtx());

    expect(devFd.isError).toBe(true);
    expect(procFd.isError).toBe(true);
    expect(devFd.data.content).toContain("blocked");
    expect(procFd.data.content).toContain("blocked");
  });

  test("blocks Linux block/input device path patterns", () => {
    for (const path of ["/dev/sda", "/dev/sda1", "/dev/nvme0n1p1", "/dev/mapper/root", "/dev/input/event0"]) {
      const result = checkFileReadPathSafety(path);

      expect(result.blocked, path).toBe(true);
    }
  });

  test("blocks macOS disk and serial device path patterns", () => {
    for (const path of ["/dev/disk0", "/dev/disk2s1", "/dev/rdisk0", "/dev/tty.usbserial-110", "/dev/cu.usbserial-110"]) {
      const result = checkFileReadPathSafety(path);

      expect(result.blocked, path).toBe(true);
    }
  });

  test("does not block /dev/null read policy", () => {
    expect(checkFileReadPathSafety("/dev/null").blocked).toBe(false);
  });

  test("records FileRead state with content, mtime, offset, limit, and partial flag", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "state.txt");
    writeFileSync(filePath, "alpha\nbeta\n", "utf8");
    const ctx = makeCtx(cwd);

    await readBeforeEdit(ctx, filePath, { offset: 0, limit: 10 });
    const fullState = ctx.readFileState?.get(filePath);

    expect(fullState?.filePath).toBe(filePath);
    expect(fullState?.content).toBe("alpha\nbeta\n");
    expect(typeof fullState?.mtimeMs).toBe("number");
    expect(fullState?.offset).toBe(0);
    expect(fullState?.limit).toBe(10);
    expect(fullState?.isPartialView).toBe(false);

    await readBeforeEdit(ctx, filePath, { offset: 1, limit: 1 });
    expect(ctx.readFileState?.get(filePath)?.isPartialView).toBe(true);
    expect(ctx.readFileState?.get(filePath)?.offset).toBe(1);
    expect(ctx.readFileState?.get(filePath)?.limit).toBe(1);
  });
});

describe("FileEditTool safety guards", () => {
  test("rejects no-op edits without mutating the file", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "noop.txt");
    writeFileSync(filePath, "hello\n", "utf8");

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "hello", new_string: "hello" },
      makeCtx(cwd),
    );

    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("no_op");
    expect(readFileSync(filePath, "utf8")).toBe("hello\n");
  });

  test("rejects files larger than MAX_EDIT_FILE_SIZE", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "large.txt");
    writeFileSync(filePath, "x", "utf8");
    truncateSync(filePath, MAX_EDIT_FILE_SIZE + 1);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "x", new_string: "y" },
      makeCtx(cwd),
    );

    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("too_large");
  });

  test("preserves UTF-16LE BOM and encoding while editing", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "utf16.txt");
    writeFileSync(filePath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("hello world\n", "utf16le"),
    ]));
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "world", new_string: "agent" },
      ctx,
    );
    const buffer = readFileSync(filePath);

    expect(result.isError).toBeUndefined();
    expect(buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(buffer.subarray(2).toString("utf16le")).toBe("hello agent\n");
  });

  test("rejects null-byte binary files without mutating the file", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "binary.bin");
    const original = Buffer.from([0x61, 0x00, 0x62, 0x0a]);
    writeFileSync(filePath, original);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "a", new_string: "x" },
      makeCtx(cwd),
    );

    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("binary_file");
    expect(readFileSync(filePath).equals(original)).toBe(true);
  });

  test("matches straight quotes against curly quotes and preserves quote style", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "quotes.txt");
    writeFileSync(filePath, "const message = “hello”;\n", "utf8");
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath);

    const result = await FileEditTool.call(
      {
        file_path: filePath,
        old_string: 'const message = "hello";',
        new_string: 'const message = "bye";',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("const message = “bye”;\n");
  });

  test("normalizes replacement line endings to preserve CRLF files", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "crlf.txt");
    writeFileSync(filePath, "alpha\r\nbeta\r\n", "utf8");
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "alpha\nbeta", new_string: "one\ntwo" },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("one\r\ntwo\r\n");
  });

  test("uses a cleaned-up same-directory temp path for successful writes", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "atomic.txt");
    writeFileSync(filePath, "before\n", "utf8");
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      ctx,
    );
    const tempFiles = readdirSync(cwd).filter((name) => name.includes("coreline-edit"));

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("after\n");
    expect(tempFiles).toEqual([]);
  });

  test("rejects edits before a full FileRead", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "unread.txt");
    writeFileSync(filePath, "before\n", "utf8");

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      makeCtx(cwd),
    );

    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("unread");
    expect(readFileSync(filePath, "utf8")).toBe("before\n");
  });

  test("rejects edits after a partial FileRead", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "partial.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\n", "utf8");
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath, { offset: 0, limit: 1 });

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "alpha", new_string: "ALPHA" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("partial_read");
    expect(readFileSync(filePath, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  test("rejects stale writes when content changed after FileRead", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "stale.txt");
    writeFileSync(filePath, "alpha\n", "utf8");
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath);
    writeFileSync(filePath, "alpha external\n", "utf8");

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "alpha", new_string: "beta" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.data.errorReason).toBe("stale_write");
    expect(readFileSync(filePath, "utf8")).toBe("alpha external\n");
  });

  test("allows edits when only mtime changed and content is identical", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "mtime-only.txt");
    writeFileSync(filePath, "alpha\n", "utf8");
    const ctx = makeCtx(cwd);
    await readBeforeEdit(ctx, filePath);
    const touchedAt = new Date(Date.now() + 5000);
    utimesSync(filePath, touchedAt, touchedAt);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "alpha", new_string: "beta" },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf8")).toBe("beta\n");
  });

  test("updates read state and invalidates FileRead cache after successful edits", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "cache.txt");
    writeFileSync(filePath, "before\n", "utf8");
    const toolCache = new ToolCache();
    const ctx = makeCtx(cwd, { toolCache });
    await readBeforeEdit(ctx, filePath);

    expect(toolCache.getStats().size).toBe(1);

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(ctx.readFileState?.get(filePath)?.content).toBe("after\n");
    expect(ctx.readFileState?.get(filePath)?.isPartialView).toBe(false);
    expect(toolCache.getStats().size).toBe(0);
  });
});
