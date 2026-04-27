/**
 * Session-local multi-file transaction helper.
 *
 * This sits on top of BackupStoreLike and does not replace existing write/edit
 * safety. Call add(file) before mutating a path, then commit() or rollback().
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BackupStoreLike } from "./file-backup.js";
import type { ToolCache } from "./tool-cache.js";
import type {
  FileTransactionEntry,
  FileTransactionRecord,
  FileTransactionRollbackFailure,
  FileTransactionRollbackReport,
  FileTransactionStatus,
} from "./hardening-types.js";

export interface FileTransactionOptions {
  id?: string;
  label?: string;
  backupStore: BackupStoreLike;
  toolCache?: Pick<ToolCache, "invalidatePath">;
  now?: () => Date;
}

export class FileTransaction {
  private readonly backupStore: BackupStoreLike;
  private readonly toolCache?: Pick<ToolCache, "invalidatePath">;
  private readonly now: () => Date;
  private readonly seen = new Set<string>();
  private record: FileTransactionRecord;

  constructor(options: FileTransactionOptions) {
    this.backupStore = options.backupStore;
    this.toolCache = options.toolCache;
    this.now = options.now ?? (() => new Date());
    this.record = {
      id: options.id ?? randomUUID(),
      label: options.label,
      startedAt: this.now().toISOString(),
      status: "active",
      files: [],
    };
  }

  static begin(options: FileTransactionOptions): FileTransaction {
    return new FileTransaction(options);
  }

  get id(): string {
    return this.record.id;
  }

  get status(): FileTransactionStatus {
    return this.record.status;
  }

  snapshot(): FileTransactionRecord {
    return {
      ...this.record,
      files: this.record.files.map((entry) => ({ ...entry })),
    };
  }

  async add(filePath: string): Promise<FileTransactionEntry> {
    this.assertActive();
    const resolved = resolve(filePath);
    const existing = this.record.files.find((entry) => entry.filePath === resolved);
    if (existing) return existing;

    const backup = await this.backupStore.backup(resolved);
    const entry: FileTransactionEntry = {
      filePath: resolved,
      backup,
      addedAt: this.now().toISOString(),
    };
    this.record.files.push(entry);
    this.seen.add(resolved);
    return entry;
  }

  async commit(): Promise<FileTransactionRecord> {
    this.assertActive();
    this.record = {
      ...this.record,
      status: "committed",
      completedAt: this.now().toISOString(),
    };
    return this.snapshot();
  }

  async rollback(): Promise<FileTransactionRollbackReport> {
    if (this.record.status !== "active") {
      return {
        transactionId: this.record.id,
        restored: [],
        failed: [{ filePath: "", message: `Transaction is not active: ${this.record.status}` }],
        invalidated: [],
        status: "partial",
      };
    }

    const restored: string[] = [];
    const failed: FileTransactionRollbackFailure[] = [];
    const invalidated: string[] = [];

    for (const entry of [...this.record.files].reverse()) {
      try {
        await this.backupStore.restore(entry.filePath);
        restored.push(entry.filePath);
      } catch (error) {
        failed.push({
          filePath: entry.filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        this.toolCache?.invalidatePath(entry.filePath);
        invalidated.push(entry.filePath);
      } catch (error) {
        failed.push({
          filePath: entry.filePath,
          message: `Cache invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    this.record = {
      ...this.record,
      status: failed.length > 0 ? "rollback_partial" : "rolled_back",
      completedAt: this.now().toISOString(),
    };

    return {
      transactionId: this.record.id,
      restored,
      failed,
      invalidated,
      status: failed.length > 0 ? "partial" : "rolled_back",
    };
  }

  has(filePath: string): boolean {
    return this.seen.has(resolve(filePath));
  }

  private assertActive(): void {
    if (this.record.status !== "active") {
      throw new Error(`Transaction is not active: ${this.record.status}`);
    }
  }
}
