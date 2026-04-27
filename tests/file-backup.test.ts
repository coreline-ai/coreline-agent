import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupStore } from "../src/agent/file-backup.js";
import { FileEditTool } from "../src/tools/file-edit/file-edit-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import type { ToolUseContext } from "../src/tools/types.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-file-backup-"));
  tempDirs.push(dir);
  return dir;
}

function createContext(cwd: string, backupStore?: BackupStore): ToolUseContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    nonInteractive: false,
    ...(backupStore ? { backupStore } : {}),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("BackupStore", () => {
  test("backs up and restores an existing file", () => {
    const cwd = tempProject();
    const backupsDir = join(cwd, ".backups");
    const filePath = join(cwd, "note.txt");
    writeFileSync(filePath, "original", "utf-8");
    const store = new BackupStore({ sessionId: "s1", backupsDir });

    const entry = store.backup(filePath);
    writeFileSync(filePath, "changed", "utf-8");
    const restored = store.restore(filePath);

    expect(restored?.id).toBe(entry.id);
    expect(readFileSync(filePath, "utf-8")).toBe("original");
  });

  test("restoring a backup for a newly created file deletes the file", () => {
    const cwd = tempProject();
    const filePath = join(cwd, "new.txt");
    const store = new BackupStore({ sessionId: "s1", backupsDir: join(cwd, ".backups") });

    store.backup(filePath);
    writeFileSync(filePath, "created", "utf-8");
    store.restore(filePath);

    expect(existsSync(filePath)).toBe(false);
  });

  test("cleanup removes expired backup files", () => {
    const cwd = tempProject();
    const filePath = join(cwd, "old.txt");
    writeFileSync(filePath, "old", "utf-8");
    const store = new BackupStore({ sessionId: "s1", backupsDir: join(cwd, ".backups") });
    const entry = store.backup(filePath);
    const oldDate = new Date(Date.now() - 10_000);
    utimesSync(entry.metadataPath, oldDate, oldDate);
    if (entry.backupPath) utimesSync(entry.backupPath, oldDate, oldDate);

    const removed = store.cleanup(1);

    expect(removed).toBeGreaterThanOrEqual(1);
  });

  test("keeps the first backup when the same file is edited twice", () => {
    const cwd = tempProject();
    const filePath = join(cwd, "twice.txt");
    writeFileSync(filePath, "v1", "utf-8");
    const store = new BackupStore({ sessionId: "s1", backupsDir: join(cwd, ".backups") });

    store.backup(filePath);
    writeFileSync(filePath, "v2", "utf-8");
    store.backup(filePath);
    writeFileSync(filePath, "v3", "utf-8");
    store.restoreLast();

    expect(readFileSync(filePath, "utf-8")).toBe("v1");
    expect(store.listBackups()).toHaveLength(1);
  });
});

describe("file write/edit backup integration", () => {
  test("FileWrite creates an undo backup before overwriting", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "write.txt");
    writeFileSync(filePath, "before", "utf-8");
    const store = new BackupStore({ sessionId: "s1", backupsDir: join(cwd, ".backups") });

    const result = await FileWriteTool.call(
      { file_path: filePath, content: "after" },
      createContext(cwd, store),
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("after");
    store.restoreLast();
    expect(readFileSync(filePath, "utf-8")).toBe("before");
  });

  test("FileEdit creates an undo backup and returns a diff", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "edit.txt");
    writeFileSync(filePath, "hello\nworld\n", "utf-8");
    const store = new BackupStore({ sessionId: "s1", backupsDir: join(cwd, ".backups") });

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "world", new_string: "agent" },
      createContext(cwd, store),
    );
    const formatted = FileEditTool.formatResult(result.data, "tc_1");

    expect(result.isError).toBeUndefined();
    expect(formatted).toContain("```diff");
    expect(formatted).toContain("-world");
    expect(formatted).toContain("+agent");
    store.restoreLast();
    expect(readFileSync(filePath, "utf-8")).toBe("hello\nworld\n");
  });

  test("tools keep existing behavior when backupStore is not provided", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "plain.txt");

    const result = await FileWriteTool.call(
      { file_path: filePath, content: "plain" },
      createContext(cwd),
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("plain");
  });
});
