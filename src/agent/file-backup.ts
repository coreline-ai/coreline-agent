/**
 * File backup store for safe write/edit operations.
 *
 * Backups are session-scoped and advisory. The store keeps one original backup
 * per file path in a session so repeated edits can still undo to the first
 * pre-edit state.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { paths, ensureConfigDirs } from "../config/paths.js";

export interface BackupEntry {
  id: string;
  sessionId: string;
  originalPath: string;
  backupPath?: string;
  metadataPath: string;
  createdAt: string;
  existed: boolean;
  sizeBytes?: number;
}

export interface BackupStoreOptions {
  sessionId: string;
  backupsDir?: string;
}

export interface BackupStoreLike {
  backup(filePath: string): Promise<BackupEntry> | BackupEntry;
  restore(filePath: string): Promise<BackupEntry | null> | BackupEntry | null;
  restoreLast(): Promise<BackupEntry | null> | BackupEntry | null;
  listBackups(sessionId?: string): BackupEntry[];
  cleanup(maxAgeMs?: number): number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function hashPath(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function safeName(filePath: string): string {
  return basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
}

function readJson(path: string): BackupEntry | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BackupEntry;
  } catch {
    return null;
  }
}

function atomicCopy(source: string, destination: string): void {
  const temp = `${destination}.tmp-${randomUUID()}`;
  copyFileSync(source, temp);
  renameSync(temp, destination);
}

function atomicWriteJson(path: string, value: BackupEntry): void {
  const temp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(temp, path);
}

export class BackupStore implements BackupStoreLike {
  readonly sessionId: string;
  readonly backupsDir: string;
  private readonly byPath = new Map<string, BackupEntry>();
  private lastPath: string | undefined;

  constructor(options: BackupStoreOptions | string) {
    if (typeof options === "string") {
      this.sessionId = options;
      this.backupsDir = paths.backupsDir;
    } else {
      this.sessionId = options.sessionId;
      this.backupsDir = options.backupsDir ?? paths.backupsDir;
    }
  }

  private sessionDir(sessionId = this.sessionId): string {
    return join(this.backupsDir, sessionId);
  }

  private ensureSessionDir(): string {
    ensureConfigDirs();
    const dir = this.sessionDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  backup(filePath: string): BackupEntry {
    const originalPath = resolve(filePath);
    const existing = this.byPath.get(originalPath) ?? this.findEntryForPath(originalPath);
    if (existing) {
      this.byPath.set(originalPath, existing);
      this.lastPath = originalPath;
      return existing;
    }

    const dir = this.ensureSessionDir();
    const createdAt = new Date().toISOString();
    const id = `${Date.now()}_${hashPath(originalPath)}_${safeName(originalPath)}`;
    const metadataPath = join(dir, `${id}.json`);
    const existed = existsSync(originalPath);
    const backupPath = existed ? join(dir, `${id}.bak`) : undefined;
    const entry: BackupEntry = {
      id,
      sessionId: this.sessionId,
      originalPath,
      backupPath,
      metadataPath,
      createdAt,
      existed,
      sizeBytes: existed ? statSync(originalPath).size : undefined,
    };

    if (existed && backupPath) {
      atomicCopy(originalPath, backupPath);
    }
    atomicWriteJson(metadataPath, entry);
    this.byPath.set(originalPath, entry);
    this.lastPath = originalPath;
    return entry;
  }

  restore(filePath: string): BackupEntry | null {
    const originalPath = resolve(filePath);
    const entry = this.byPath.get(originalPath) ?? this.findEntryForPath(originalPath);
    if (!entry) return null;

    if (entry.existed) {
      if (!entry.backupPath || !existsSync(entry.backupPath)) {
        throw new Error(`Backup file missing for ${entry.originalPath}`);
      }
      mkdirSync(dirname(entry.originalPath), { recursive: true });
      atomicCopy(entry.backupPath, entry.originalPath);
    } else if (existsSync(entry.originalPath)) {
      rmSync(entry.originalPath, { force: true });
    }

    this.lastPath = originalPath;
    return entry;
  }

  restoreLast(): BackupEntry | null {
    if (!this.lastPath) {
      const latest = this.listBackups()[0];
      if (!latest) return null;
      return this.restore(latest.originalPath);
    }
    return this.restore(this.lastPath);
  }

  listBackups(sessionId = this.sessionId): BackupEntry[] {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(join(dir, name)))
      .filter((entry): entry is BackupEntry => Boolean(entry))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  cleanup(maxAgeMs = DEFAULT_TTL_MS): number {
    const root = this.backupsDir;
    if (!existsSync(root)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const sessionName of readdirSync(root)) {
      const sessionDir = join(root, sessionName);
      if (!statSync(sessionDir).isDirectory()) continue;
      for (const fileName of readdirSync(sessionDir)) {
        const filePath = join(sessionDir, fileName);
        if (statSync(filePath).mtimeMs < cutoff) {
          rmSync(filePath, { force: true, recursive: false });
          removed++;
        }
      }
    }
    return removed;
  }

  private findEntryForPath(originalPath: string): BackupEntry | null {
    const entries = this.listBackups().filter((entry) => entry.originalPath === originalPath);
    return entries.at(-1) ?? entries[0] ?? null;
  }
}
