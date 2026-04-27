/**
 * Global User Memory — stores user-wide preferences, workflows, feedback
 * that persist across projects.
 *
 * Storage: ~/.coreline-agent/user-memory/
 * Format: same frontmatter markdown as project memory, with extended fields.
 * Precedence: always lower than project memory (advisory only).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { paths } from "../config/paths.js";
import { MEMORY_INDEX_FILE } from "./constants.js";
import { parseMemoryFile } from "./memory-parser.js";
import type {
  GlobalMemoryProvenance,
  GlobalMemoryType,
  GlobalUserMemoryCore,
  GlobalUserMemoryEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const VALID_GLOBAL_TYPES = new Set<string>(["preference", "workflow", "environment", "feedback", "reference"]);

function isValidGlobalMemoryType(type: string): type is GlobalMemoryType {
  return VALID_GLOBAL_TYPES.has(type);
}

function validateEntryName(name: string): void {
  if (!name || !VALID_NAME_RE.test(name)) {
    throw new Error(
      `Invalid global memory entry name "${name}". Must match ${VALID_NAME_RE.source}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeGlobalEntry(
  entry: Omit<GlobalUserMemoryEntry, "filePath">,
): string {
  const frontmatter = stringifyYaml({
    name: entry.name,
    description: entry.description,
    type: entry.type,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    provenance: entry.provenance,
  }).trimEnd();

  return `---\n${frontmatter}\n---\n${entry.body ?? ""}`;
}

function parseGlobalEntry(
  content: string,
  filePath: string,
): GlobalUserMemoryEntry | null {
  const { frontmatter, body } = parseMemoryFile(content);
  const name = String(frontmatter.name ?? "");
  const type = String(frontmatter.type ?? "preference");

  if (!name || !isValidGlobalMemoryType(type)) {
    return null;
  }

  const provenance: GlobalMemoryProvenance =
    frontmatter.provenance && typeof frontmatter.provenance === "object"
      ? (frontmatter.provenance as GlobalMemoryProvenance)
      : { source: "manual" };

  return {
    name,
    type,
    description: String(frontmatter.description ?? ""),
    body: body.trim(),
    filePath,
    createdAt: String(frontmatter.createdAt ?? new Date().toISOString()),
    updatedAt: String(frontmatter.updatedAt ?? new Date().toISOString()),
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function buildIndexContent(entries: GlobalUserMemoryEntry[]): string {
  if (entries.length === 0) return "";

  const lines = entries.map(
    (e) => `- [${e.name}](${e.name}.md) — ${e.description || e.type}`,
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GlobalUserMemory implements GlobalUserMemoryCore {
  readonly memoryDir: string;

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir ?? paths.userMemoryDir;
  }

  private ensureDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  private entryPath(name: string): string {
    return join(this.memoryDir, `${name}.md`);
  }

  private indexPath(): string {
    return join(this.memoryDir, MEMORY_INDEX_FILE);
  }

  private writeIndex(entries: GlobalUserMemoryEntry[]): void {
    const content = buildIndexContent(entries);
    const indexPath = this.indexPath();
    const tempPath = join(dirname(indexPath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    writeFileSync(tempPath, content, "utf-8");
    renameSync(tempPath, indexPath);
  }

  loadAll(): GlobalUserMemoryEntry[] {
    if (!existsSync(this.memoryDir)) return [];

    const files = readdirSync(this.memoryDir).filter(
      (f) => f.endsWith(".md") && f !== MEMORY_INDEX_FILE,
    );

    const entries: GlobalUserMemoryEntry[] = [];
    for (const file of files) {
      const filePath = join(this.memoryDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const entry = parseGlobalEntry(content, filePath);
        if (entry) entries.push(entry);
      } catch {
        // skip unreadable files
      }
    }

    return entries;
  }

  listEntries(): GlobalUserMemoryEntry[] {
    return this.loadAll();
  }

  readEntry(name: string): GlobalUserMemoryEntry | null {
    validateEntryName(name);
    const filePath = this.entryPath(name);
    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath, "utf-8");
      return parseGlobalEntry(content, filePath);
    } catch {
      return null;
    }
  }

  writeEntry(
    entry: Omit<GlobalUserMemoryEntry, "filePath" | "updatedAt"> & { updatedAt?: string },
  ): void {
    validateEntryName(entry.name);
    this.ensureDir();

    const now = new Date().toISOString();
    const fullEntry: Omit<GlobalUserMemoryEntry, "filePath"> = {
      ...entry,
      updatedAt: entry.updatedAt ?? now,
      createdAt: entry.createdAt || now,
    };

    const filePath = this.entryPath(entry.name);
    const content = serializeGlobalEntry(fullEntry);
    const tempPath = join(dirname(filePath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    writeFileSync(tempPath, content, "utf-8");
    renameSync(tempPath, filePath);

    // Update index
    const allEntries = this.loadAll();
    this.writeIndex(allEntries);
  }

  deleteEntry(name: string): boolean {
    validateEntryName(name);
    const filePath = this.entryPath(name);
    if (!existsSync(filePath)) return false;

    try {
      unlinkSync(filePath);
      // Update index
      const allEntries = this.loadAll();
      this.writeIndex(allEntries);
      return true;
    } catch {
      return false;
    }
  }
}
