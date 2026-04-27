/**
 * Small deterministic cache for read-only tool calls.
 *
 * The cache is deliberately independent from FileRead/Glob wiring. Integration
 * layers can inject it later and call invalidatePath()/invalidateAll() after
 * write/edit/rollback operations.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolCacheInvalidation, ToolCachePolicy, ToolCacheRequest, ToolCacheStats } from "./hardening-types.js";

export interface ToolCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface PathSignature {
  original: string;
  resolved: string;
  realpath: string;
  mtimeMs: number | null;
  exists: boolean;
}

interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  paths: Set<string>;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 256;

export const DEFAULT_TOOL_CACHE_POLICY: ToolCachePolicy = {
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  includeMtime: true,
  includeRealpath: true,
};

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function pathSignature(cwd: string, filePath: string): PathSignature {
  const resolved = resolve(cwd, filePath);
  if (!existsSync(resolved)) {
    return { original: filePath, resolved, realpath: resolved, mtimeMs: null, exists: false };
  }
  const realpath = realpathSync(resolved);
  const stats = statSync(realpath);
  return {
    original: filePath,
    resolved,
    realpath,
    mtimeMs: stats.mtimeMs,
    exists: true,
  };
}

function inferPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const candidates = [record.file_path, record.path, record.cwd]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(candidates)];
}

function collectPathSignatures(request: ToolCacheRequest): PathSignature[] {
  const paths = request.paths ?? inferPaths(request.input);
  return paths.map((filePath) => pathSignature(request.cwd, filePath));
}

export function createToolCacheKey(request: ToolCacheRequest): string {
  const cwd = resolve(request.cwd);
  const pathSignatures = collectPathSignatures(request).map((signature) => ({
    realpath: signature.realpath,
    mtimeMs: signature.mtimeMs,
    exists: signature.exists,
  }));
  return stableStringify({
    cwd,
    toolName: request.toolName,
    input: request.input,
    paths: pathSignatures,
  });
}

export class ToolCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ToolCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  get policy(): ToolCachePolicy {
    return {
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      includeMtime: true,
      includeRealpath: true,
    };
  }

  getStats(): ToolCacheStats {
    this.pruneExpired();
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  get<T>(request: ToolCacheRequest): T | undefined {
    const key = createToolCacheKey(request);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    entry.lastAccessedAt = this.now();
    this.hits++;
    return entry.value as T;
  }

  set<T>(request: ToolCacheRequest, value: T): T {
    const key = createToolCacheKey(request);
    const paths = new Set<string>();
    for (const signature of collectPathSignatures(request)) {
      paths.add(signature.resolved);
      paths.add(signature.realpath);
    }
    const createdAt = this.now();
    this.entries.set(key, {
      key,
      value,
      createdAt,
      lastAccessedAt: createdAt,
      paths,
    });
    this.evictIfNeeded();
    return value;
  }

  async getOrSet<T>(request: ToolCacheRequest, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(request);
    if (cached !== undefined) return cached;
    const value = await loader();
    return this.set(request, value);
  }

  invalidatePath(filePath: string): ToolCacheInvalidation {
    const resolved = resolve(filePath);
    const realpath = existsSync(resolved) ? realpathSync(resolved) : resolved;
    let removedEntries = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.paths.has(resolved) || entry.paths.has(realpath)) {
        this.entries.delete(key);
        removedEntries++;
      }
    }
    return { kind: "path", path: resolved, removedEntries };
  }

  invalidateAll(): ToolCacheInvalidation {
    const removedEntries = this.entries.size;
    this.entries.clear();
    return { kind: "all", removedEntries };
  }

  private isExpired(entry: CacheEntry): boolean {
    return this.ttlMs >= 0 && this.now() - entry.createdAt > this.ttlMs;
  }

  private pruneExpired(): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      if (this.isExpired(entry)) this.entries.delete(key);
    }
  }

  private evictIfNeeded(): void {
    this.pruneExpired();
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0];
      if (!oldest) return;
      this.entries.delete(oldest.key);
      this.evictions++;
    }
  }
}
