/**
 * ProjectMemory core — project-scoped memory storage and index management.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { ensureProjectMemoryDir, getProjectDir, getProjectMemoryDir } from "../config/paths.js";
import { findAgentMd, loadAgentMdContent } from "./agent-md-loader.js";
import { MEMORY_INDEX_FILE } from "./constants.js";
import { getProjectId, writeProjectMetadata } from "./project-id.js";
import { parseMemoryFile, serializeMemoryFile, validateMemoryType, extractExtendedFields } from "./memory-parser.js";
import { invalidate as invalidateTierCache } from "./tier-list-cache.js";
import type { MemoryEntry, MemoryIndexEntry, ProjectMemoryCore, ProjectMemorySnapshot } from "./types.js";

export interface ProjectMemoryOptions {
  rootDir?: string;
}

function sanitizeFileStem(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("memory entry name is required");
  }
  return trimmed.replace(/[\\/]/g, "_");
}

function stripMarkdownName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function stripMarkdownDescription(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function entryFileName(entryName: string): string {
  return `${sanitizeFileStem(entryName)}.md`;
}

function buildIndexContent(entries: MemoryIndexEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = ["# Memory Index", ""];
  for (const entry of entries) {
    lines.push(`- \`${entry.name}\` — ${entry.description || "(no description)"}`);
    lines.push(
      `  <!-- coreline-memory-entry: ${JSON.stringify({
        name: entry.name,
        type: entry.type,
        description: entry.description,
        file: entry.file,
      })} -->`,
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}

function parseIndexEntries(rawIndex: string): MemoryIndexEntry[] {
  if (!rawIndex.trim()) {
    return [];
  }

  const entries: MemoryIndexEntry[] = [];
  const commentRe = /<!--\s*coreline-memory-entry:\s*({[\s\S]*?})\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = commentRe.exec(rawIndex)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? "{}") as Partial<MemoryIndexEntry>;
      const name = stripMarkdownName(parsed.name);
      const description = stripMarkdownDescription(parsed.description);
      const file = stripMarkdownName(parsed.file);
      const type = typeof parsed.type === "string" && validateMemoryType(parsed.type) ? parsed.type : undefined;
      if (!name || !description || !file || !type) {
        continue;
      }
      entries.push({ name, description, file, type });
    } catch {
      continue;
    }
  }

  return entries;
}

export class ProjectMemory implements ProjectMemoryCore {
  readonly cwd: string;
  readonly projectId: string;
  readonly projectDir: string;
  readonly memoryDir: string;
  readonly metadataPath: string;

  private readonly rootDir?: string;

  constructor(cwd: string, options: ProjectMemoryOptions = {}) {
    this.cwd = resolve(cwd);
    this.rootDir = options.rootDir;
    this.projectId = getProjectId(this.cwd);
    this.projectDir = getProjectDir(this.projectId, this.rootDir);
    this.memoryDir = getProjectMemoryDir(this.projectId, this.rootDir);
    this.metadataPath = join(this.projectDir, "metadata.json");
  }

  private ensureStorage(): void {
    ensureProjectMemoryDir(this.projectId, this.rootDir);
    if (!existsSync(this.projectDir)) {
      mkdirSync(this.projectDir, { recursive: true });
    }
    writeProjectMetadata(this.cwd, this.rootDir);
  }

  private getIndexPath(): string {
    return join(this.memoryDir, MEMORY_INDEX_FILE);
  }

  private getEntryPath(name: string): string {
    return join(this.memoryDir, entryFileName(name));
  }

  private listEntryFiles(): string[] {
    if (!existsSync(this.memoryDir)) {
      return [];
    }
    return readdirSync(this.memoryDir)
      .filter((file) => file.endsWith(".md") && file !== MEMORY_INDEX_FILE)
      .map((file) => join(this.memoryDir, file))
      .sort();
  }

  loadAll(): ProjectMemorySnapshot {
    this.ensureStorage();

    const agentFiles = findAgentMd(this.cwd);
    const agentMd = loadAgentMdContent(agentFiles);
    const memoryIndex = this.loadMemoryIndex();
    const entries = this.listEntries()
      .map((entry) => this.readEntry(entry.name))
      .filter((entry): entry is MemoryEntry => entry != null);

    return { agentMd, memoryIndex, entries };
  }

  private loadMemoryIndex(): string {
    const indexPath = this.getIndexPath();
    if (!existsSync(indexPath)) {
      return "";
    }
    return readFileSync(indexPath, "utf-8");
  }

  listEntries(): MemoryIndexEntry[] {
    const rawIndex = this.loadMemoryIndex();
    const parsed = parseIndexEntries(rawIndex);
    if (parsed.length > 0) {
      return parsed;
    }

    return this.listEntryFiles().flatMap((filePath) => {
      try {
        const parsedFile = parseMemoryFile(readFileSync(filePath, "utf-8"));
        const name = stripMarkdownName(parsedFile.frontmatter.name);
        const description = stripMarkdownDescription(parsedFile.frontmatter.description);
        const type =
          typeof parsedFile.frontmatter.type === "string" && validateMemoryType(parsedFile.frontmatter.type)
            ? parsedFile.frontmatter.type
            : undefined;
        if (!name || !description || !type) {
          return [];
        }
        return [
          {
            name,
            description,
            type,
            file: basename(filePath),
          } satisfies MemoryIndexEntry,
        ];
      } catch {
        return [];
      }
    });
  }

  readEntry(name: string): MemoryEntry | null {
    const entryName = sanitizeFileStem(name);
    const filePath = this.getEntryPath(entryName);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = parseMemoryFile(readFileSync(filePath, "utf-8"));
      const parsedName = stripMarkdownName(parsed.frontmatter.name) || entryName;
      const description = stripMarkdownDescription(parsed.frontmatter.description);
      const type =
        typeof parsed.frontmatter.type === "string" && validateMemoryType(parsed.frontmatter.type)
          ? parsed.frontmatter.type
          : undefined;
      if (!description || !type) {
        return null;
      }

      const extended = extractExtendedFields(parsed.frontmatter);

      return {
        name: parsedName,
        description,
        type,
        body: parsed.body,
        filePath,
        ...extended,
      };
    } catch {
      return null;
    }
  }

  writeEntry(entry: MemoryEntry): void {
    if (!validateMemoryType(entry.type)) {
      throw new Error(`Invalid memory type: ${entry.type}`);
    }

    this.ensureStorage();

    const sanitizedName = sanitizeFileStem(entry.name);
    const filePath = this.getEntryPath(sanitizedName);
    const indexEntries = this.listEntries();
    const nextEntry: MemoryIndexEntry = {
      name: sanitizedName,
      description: entry.description.trim(),
      type: entry.type,
      file: `${sanitizedName}.md`,
    };

    const existingIndex = indexEntries.findIndex((item) => item.name === sanitizedName);
    if (existingIndex >= 0) {
      indexEntries.splice(existingIndex, 1, nextEntry);
    } else {
      indexEntries.push(nextEntry);
    }

    writeFileSync(filePath, serializeMemoryFile({ ...entry, name: sanitizedName }), "utf-8");
    writeFileSync(this.getIndexPath(), buildIndexContent(indexEntries), "utf-8");
    // O2: invalidate tier-list cache after any write
    try { invalidateTierCache(this.projectId); } catch { /* best-effort */ }
  }

  deleteEntry(name: string): boolean {
    this.ensureStorage();

    const sanitizedName = sanitizeFileStem(name);
    const filePath = this.getEntryPath(sanitizedName);
    const indexEntries = this.listEntries();
    const nextEntries = indexEntries.filter((entry) => entry.name !== sanitizedName);

    if (!existsSync(filePath) && nextEntries.length === indexEntries.length) {
      return false;
    }

    if (existsSync(filePath)) {
      rmSync(filePath);
    }

    const indexPath = this.getIndexPath();
    if (nextEntries.length === 0) {
      if (existsSync(indexPath)) {
        rmSync(indexPath);
      }
    } else {
      writeFileSync(indexPath, buildIndexContent(nextEntries), "utf-8");
    }

    // O2: invalidate tier-list cache after delete
    try { invalidateTierCache(this.projectId); } catch { /* best-effort */ }

    return true;
  }
}
