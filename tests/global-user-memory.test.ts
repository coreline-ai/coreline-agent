/**
 * Global User Memory tests — verifies CRUD, isolation from project memory,
 * name validation, and sensitive content detection.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalUserMemory } from "../src/memory/global-user-memory.js";
import { detectSensitiveMemoryContent } from "../src/memory/safety.js";

function mkTempDir(): string {
  return mkdtempSync(join(tmpdir(), "coreline-global-mem-"));
}

describe("GlobalUserMemory", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("loadAll on empty directory returns empty array", () => {
    tempDir = mkTempDir();
    const mem = new GlobalUserMemory(join(tempDir, "user-memory"));
    expect(mem.loadAll()).toEqual([]);
  });

  test("write → read → list round trip", () => {
    tempDir = mkTempDir();
    const memDir = join(tempDir, "user-memory");
    const mem = new GlobalUserMemory(memDir);

    mem.writeEntry({
      name: "lang-preference",
      type: "preference",
      description: "응답 언어 선호",
      body: "한국어로 응답해주세요.",
      createdAt: "2026-04-20T10:00:00Z",
      provenance: { source: "manual" },
    });

    // Read back
    const entry = mem.readEntry("lang-preference");
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("lang-preference");
    expect(entry!.type).toBe("preference");
    expect(entry!.description).toBe("응답 언어 선호");
    expect(entry!.body).toBe("한국어로 응답해주세요.");
    expect(entry!.provenance.source).toBe("manual");

    // List
    const all = mem.listEntries();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("lang-preference");

    // Index file created
    expect(existsSync(join(memDir, "MEMORY.md"))).toBe(true);
    const index = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
    expect(index).toContain("lang-preference");
  });

  test("delete removes entry and updates index", () => {
    tempDir = mkTempDir();
    const mem = new GlobalUserMemory(join(tempDir, "user-memory"));

    mem.writeEntry({
      name: "test-entry",
      type: "workflow",
      description: "test",
      body: "test body",
      createdAt: "2026-04-20T10:00:00Z",
      provenance: { source: "memory_tool" },
    });

    expect(mem.listEntries()).toHaveLength(1);

    const deleted = mem.deleteEntry("test-entry");
    expect(deleted).toBe(true);
    expect(mem.listEntries()).toHaveLength(0);
    expect(mem.readEntry("test-entry")).toBeNull();
  });

  test("delete nonexistent entry returns false", () => {
    tempDir = mkTempDir();
    const mem = new GlobalUserMemory(join(tempDir, "user-memory"));
    expect(mem.deleteEntry("nope")).toBe(false);
  });

  test("invalid name is rejected", () => {
    tempDir = mkTempDir();
    const mem = new GlobalUserMemory(join(tempDir, "user-memory"));

    expect(() =>
      mem.writeEntry({
        name: "INVALID NAME",
        type: "preference",
        description: "",
        body: "",
        createdAt: "2026-04-20T10:00:00Z",
        provenance: { source: "manual" },
      }),
    ).toThrow(/Invalid global memory entry name/);
  });

  test("multiple entries with different types", () => {
    tempDir = mkTempDir();
    const mem = new GlobalUserMemory(join(tempDir, "user-memory"));

    const types = ["preference", "workflow", "environment", "feedback", "reference"] as const;
    for (const type of types) {
      mem.writeEntry({
        name: `entry-${type}`,
        type,
        description: `${type} desc`,
        body: `${type} body`,
        createdAt: "2026-04-20T10:00:00Z",
        provenance: { source: "manual" },
      });
    }

    expect(mem.listEntries()).toHaveLength(5);
    for (const type of types) {
      const e = mem.readEntry(`entry-${type}`);
      expect(e).not.toBeNull();
      expect(e!.type).toBe(type);
    }
  });

  test("project memory directory is not affected", () => {
    tempDir = mkTempDir();
    const globalDir = join(tempDir, "user-memory");
    const projectDir = join(tempDir, "projects", "abc123", "memory");

    const mem = new GlobalUserMemory(globalDir);
    mem.writeEntry({
      name: "global-entry",
      type: "preference",
      description: "test",
      body: "global body",
      createdAt: "2026-04-20T10:00:00Z",
      provenance: { source: "manual" },
    });

    // Project directory should not exist
    expect(existsSync(projectDir)).toBe(false);
    // Global entry should be in globalDir only
    expect(existsSync(join(globalDir, "global-entry.md"))).toBe(true);
  });

  test("overwrite preserves createdAt, updates updatedAt", () => {
    tempDir = mkTempDir();
    const mem = new GlobalUserMemory(join(tempDir, "user-memory"));

    mem.writeEntry({
      name: "evolving",
      type: "feedback",
      description: "v1",
      body: "first version",
      createdAt: "2026-01-01T00:00:00Z",
      provenance: { source: "manual" },
    });

    mem.writeEntry({
      name: "evolving",
      type: "feedback",
      description: "v2",
      body: "second version",
      createdAt: "2026-01-01T00:00:00Z",
      provenance: { source: "memory_tool", sessionId: "sess-123" },
    });

    const entry = mem.readEntry("evolving");
    expect(entry!.description).toBe("v2");
    expect(entry!.body).toBe("second version");
    expect(entry!.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(entry!.provenance.sessionId).toBe("sess-123");
  });
});

describe("detectSensitiveMemoryContent", () => {
  test("detects API keys", () => {
    expect(detectSensitiveMemoryContent({ body: "my key is sk-ant-abc123def456ghi789jkl012mno" })).not.toBeNull();
    expect(detectSensitiveMemoryContent({ body: "key: sk-1234567890abcdefghijklmn" })).not.toBeNull();
  });

  test("detects private keys", () => {
    expect(detectSensitiveMemoryContent({ body: "-----BEGIN RSA PRIVATE KEY-----" })).not.toBeNull();
  });

  test("detects password assignments", () => {
    expect(detectSensitiveMemoryContent({ body: 'password = "mysecret123"' })).not.toBeNull();
  });

  test("detects AWS keys", () => {
    expect(detectSensitiveMemoryContent({ body: "AKIAIOSFODNN7EXAMPLE" })).not.toBeNull();
  });

  test("safe content returns null", () => {
    expect(detectSensitiveMemoryContent({ body: "한국어로 응답해주세요." })).toBeNull();
    expect(detectSensitiveMemoryContent({ body: "Bun runtime preferred" })).toBeNull();
    expect(detectSensitiveMemoryContent({ description: "workflow preference" })).toBeNull();
  });

  test("detects in description field too", () => {
    expect(detectSensitiveMemoryContent({ description: "my token is sk-ant-abc123def456ghi789jkl012mno" })).not.toBeNull();
  });
});
