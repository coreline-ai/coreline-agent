import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupStore } from "../src/agent/file-backup.js";
import { FileTransaction } from "../src/agent/file-transaction.js";
import { ToolCache } from "../src/agent/tool-cache.js";
import type { BackupEntry, BackupStoreLike } from "../src/agent/file-backup.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-file-transaction-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function backupStore(cwd: string): BackupStore {
  return new BackupStore({ sessionId: "s1", backupsDir: join(cwd, ".backups") });
}

describe("FileTransaction", () => {
  test("rolls back changes across multiple existing files", async () => {
    const cwd = tempProject();
    const a = join(cwd, "a.txt");
    const b = join(cwd, "b.txt");
    writeFileSync(a, "a1", "utf-8");
    writeFileSync(b, "b1", "utf-8");
    const transaction = FileTransaction.begin({ backupStore: backupStore(cwd) });

    await transaction.add(a);
    await transaction.add(b);
    writeFileSync(a, "a2", "utf-8");
    writeFileSync(b, "b2", "utf-8");
    const report = await transaction.rollback();

    expect(report.status).toBe("rolled_back");
    expect(report.restored).toHaveLength(2);
    expect(readFileSync(a, "utf-8")).toBe("a1");
    expect(readFileSync(b, "utf-8")).toBe("b1");
    expect(transaction.status).toBe("rolled_back");
  });

  test("rolls back newly created files by deleting them", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "new.txt");
    const transaction = FileTransaction.begin({ backupStore: backupStore(cwd) });

    await transaction.add(filePath);
    writeFileSync(filePath, "created", "utf-8");
    await transaction.rollback();

    expect(existsSync(filePath)).toBe(false);
  });

  test("invalidates ToolCache paths during rollback", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "cached.txt");
    writeFileSync(filePath, "v1", "utf-8");
    const cache = new ToolCache();
    cache.set({ cwd, toolName: "FileRead", input: { file_path: filePath }, paths: [filePath] }, "cached");
    const transaction = FileTransaction.begin({ backupStore: backupStore(cwd), toolCache: cache });

    await transaction.add(filePath);
    writeFileSync(filePath, "v2", "utf-8");
    const report = await transaction.rollback();

    expect(report.invalidated).toContain(filePath);
    expect(cache.get({ cwd, toolName: "FileRead", input: { file_path: filePath }, paths: [filePath] })).toBeUndefined();
  });

  test("commit finalizes the transaction without restoring files", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "commit.txt");
    writeFileSync(filePath, "before", "utf-8");
    const transaction = FileTransaction.begin({ backupStore: backupStore(cwd), label: "commit-test" });

    await transaction.add(filePath);
    writeFileSync(filePath, "after", "utf-8");
    const record = await transaction.commit();

    expect(record.status).toBe("committed");
    expect(record.label).toBe("commit-test");
    expect(readFileSync(filePath, "utf-8")).toBe("after");
  });

  test("reports partial rollback failures", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "partial.txt");
    writeFileSync(filePath, "before", "utf-8");
    const entry: BackupEntry = {
      id: "b1",
      sessionId: "s1",
      originalPath: filePath,
      metadataPath: join(cwd, "meta.json"),
      createdAt: new Date().toISOString(),
      existed: true,
      sizeBytes: 6,
    };
    const failingStore: BackupStoreLike = {
      backup: () => entry,
      restore: () => { throw new Error("restore failed"); },
      restoreLast: () => null,
      listBackups: () => [entry],
      cleanup: () => 0,
    };
    const transaction = FileTransaction.begin({ backupStore: failingStore });

    await transaction.add(filePath);
    const report = await transaction.rollback();

    expect(report.status).toBe("partial");
    expect(report.failed[0]?.message).toContain("restore failed");
    expect(transaction.status).toBe("rollback_partial");
  });
});
