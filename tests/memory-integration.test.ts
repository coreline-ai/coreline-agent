/**
 * Memory integration tests — ProjectMemory load/write/read/list/delete.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory } from "../src/memory/project-memory.js";

describe("ProjectMemory", () => {
  let rootDir: string;
  let workspace: string;
  let memory: ProjectMemory;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "coreline-memory-root-"));
    workspace = mkdtempSync(join(tmpdir(), "coreline-memory-workspace-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Instructions\nUse Bun only.");
    mkdirSync(join(workspace, "nested"), { recursive: true });
    writeFileSync(join(workspace, "nested", "CLAUDE.md"), "# Nested\nPrefer strict TS.");
    memory = new ProjectMemory(join(workspace, "nested"), { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("loadAll creates project storage and loads AGENT.md", () => {
    const snapshot = memory.loadAll();
    expect(snapshot.agentMd).toContain("Use Bun only.");
    expect(snapshot.agentMd).toContain("Prefer strict TS.");
    expect(snapshot.memoryIndex).toBe("");
    expect(snapshot.entries).toEqual([]);
    expect(existsSync(memory.projectDir)).toBe(true);
    expect(existsSync(memory.memoryDir)).toBe(true);
    expect(existsSync(memory.metadataPath)).toBe(true);
  });

  test("writeEntry writes a memory file and updates the index", () => {
    memory.writeEntry({
      name: "user_profile",
      description: "내 설정",
      type: "user",
      body: "Bun 사용\nTypeScript strict 모드.",
      filePath: "",
    });

    const entry = memory.readEntry("user_profile");
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe("user_profile");
    expect(entry?.description).toBe("내 설정");
    expect(entry?.type).toBe("user");
    expect(entry?.body).toContain("Bun 사용");
    expect(existsSync(join(memory.memoryDir, "user_profile.md"))).toBe(true);
    expect(memory.listEntries()).toHaveLength(1);
    expect(memory.listEntries()[0]!.name).toBe("user_profile");
    expect(readFileSync(join(memory.memoryDir, "MEMORY.md"), "utf-8")).toContain("user_profile");
  });

  test("writeEntry overwrites existing entries without duplicates", () => {
    memory.writeEntry({
      name: "user_profile",
      description: "내 설정",
      type: "user",
      body: "Bun only.",
      filePath: "",
    });
    memory.writeEntry({
      name: "user_profile",
      description: "업데이트된 설정",
      type: "user",
      body: "Bun and Node.",
      filePath: "",
    });

    const entries = memory.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe("업데이트된 설정");
    expect(memory.readEntry("user_profile")?.body).toBe("Bun and Node.");
  });

  test("deleteEntry removes file and index entry", () => {
    memory.writeEntry({
      name: "project_rules",
      description: "프로젝트 규칙",
      type: "project",
      body: "No edits outside workspace.",
      filePath: "",
    });

    expect(memory.deleteEntry("project_rules")).toBe(true);
    expect(memory.readEntry("project_rules")).toBeNull();
    expect(memory.listEntries()).toEqual([]);
    expect(existsSync(join(memory.memoryDir, "project_rules.md"))).toBe(false);
    expect(existsSync(join(memory.memoryDir, "MEMORY.md"))).toBe(false);
  });

  test("deleteEntry returns false for missing entries", () => {
    expect(memory.deleteEntry("missing")).toBe(false);
  });

  test("readEntry returns null for missing entries", () => {
    expect(memory.readEntry("missing")).toBeNull();
  });

  test("writeEntry rejects invalid types", () => {
    expect(() =>
      memory.writeEntry({
        name: "bad_type",
        description: "bad",
        type: "invalid" as any,
        body: "oops",
        filePath: "",
      }),
    ).toThrow("Invalid memory type");
  });

  test("loadAll returns entries in index order", () => {
    memory.writeEntry({
      name: "first",
      description: "First entry",
      type: "user",
      body: "A",
      filePath: "",
    });
    memory.writeEntry({
      name: "second",
      description: "Second entry",
      type: "project",
      body: "B",
      filePath: "",
    });

    const snapshot = memory.loadAll();
    expect(snapshot.entries.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(snapshot.memoryIndex).toContain("coreline-memory-entry");
  });
});
