import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolCacheKey, stableStringify, ToolCache } from "../src/agent/tool-cache.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-tool-cache-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ToolCache", () => {
  test("stableStringify produces deterministic keys for object order", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  test("returns cached values for identical requests", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "note.txt");
    writeFileSync(filePath, "hello", "utf-8");
    const cache = new ToolCache({ ttlMs: 1000, maxEntries: 10 });
    let calls = 0;

    const request = { cwd, toolName: "FileRead", input: { file_path: filePath }, paths: [filePath] };
    const first = await cache.getOrSet(request, async () => ({ value: ++calls }));
    const second = await cache.getOrSet(request, async () => ({ value: ++calls }));

    expect(first.value).toBe(1);
    expect(second.value).toBe(1);
    expect(cache.getStats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  test("file mtime changes create a cache miss via stable key", async () => {
    const cwd = tempProject();
    const filePath = join(cwd, "note.txt");
    writeFileSync(filePath, "v1", "utf-8");
    const cache = new ToolCache({ ttlMs: 1000, maxEntries: 10 });
    const request = { cwd, toolName: "FileRead", input: { file_path: filePath }, paths: [filePath] };

    cache.set(request, "v1");
    const before = createToolCacheKey(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(filePath, "v2", "utf-8");
    const after = createToolCacheKey(request);

    expect(after).not.toBe(before);
    expect(cache.get<string>(request)).toBeUndefined();
  });

  test("supports explicit path invalidation", () => {
    const cwd = tempProject();
    const filePath = join(cwd, "note.txt");
    writeFileSync(filePath, "hello", "utf-8");
    const cache = new ToolCache();
    const request = { cwd, toolName: "FileRead", input: { file_path: filePath }, paths: [filePath] };

    cache.set(request, "cached");
    const invalidation = cache.invalidatePath(filePath);

    expect(invalidation.removedEntries).toBe(1);
    expect(cache.get(request)).toBeUndefined();
  });

  test("resolves symlinks into the cache key", () => {
    const cwd = tempProject();
    const realFile = join(cwd, "real.txt");
    const linkFile = join(cwd, "link.txt");
    writeFileSync(realFile, "hello", "utf-8");
    symlinkSync(realFile, linkFile);

    const realKey = createToolCacheKey({ cwd, toolName: "FileRead", input: { file_path: realFile }, paths: [realFile] });
    const linkKey = createToolCacheKey({ cwd, toolName: "FileRead", input: { file_path: realFile }, paths: [linkFile] });

    expect(linkKey).toBe(realKey);
  });

  test("honors ttl, max entries, and invalidateAll", () => {
    let now = 0;
    const cache = new ToolCache({ ttlMs: 10, maxEntries: 1, now: () => now });
    const cwd = tempProject();

    cache.set({ cwd, toolName: "A", input: { a: 1 } }, "a");
    cache.set({ cwd, toolName: "B", input: { b: 2 } }, "b");
    expect(cache.getStats().size).toBe(1);
    expect(cache.getStats().evictions).toBe(1);

    now = 20;
    expect(cache.get({ cwd, toolName: "B", input: { b: 2 } })).toBeUndefined();
    cache.set({ cwd, toolName: "C", input: { c: 3 } }, "c");
    expect(cache.invalidateAll()).toMatchObject({ kind: "all", removedEntries: 1 });
    expect(cache.getStats().size).toBe(0);
  });
});
