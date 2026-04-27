/**
 * Memory foundation tests — IDs, paths, loader basics.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  ensureProjectMemoryDir,
  getProjectDir,
  getProjectMemoryDir,
  paths,
} from "../src/config/paths.js";
import { findAgentMd, loadAgentMdContent } from "../src/memory/agent-md-loader.js";
import { getProjectId } from "../src/memory/project-id.js";

describe("Memory paths + project id", () => {
  test("getProjectId is deterministic and resolve-aware", () => {
    const cwd = "/tmp/foo/../foo";
    const expected = createHash("sha256").update("/tmp/foo").digest("hex").slice(0, 16);
    expect(getProjectId(cwd)).toBe(expected);
    expect(getProjectId("/tmp/foo")).toBe(expected);
  });

  test("memory paths derive from project id", () => {
    const projectId = "deadbeef12345678";
    expect(getProjectDir(projectId, "/config-root")).toBe("/config-root/projects/deadbeef12345678");
    expect(getProjectMemoryDir(projectId, "/config-root")).toBe(
      "/config-root/projects/deadbeef12345678/memory",
    );
  });

  test("ensureProjectMemoryDir creates the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-memory-paths-"));
    const projectId = "test1234";
    const memoryDir = ensureProjectMemoryDir(projectId, root);
    expect(memoryDir).toBe(join(root, "projects", projectId, "memory"));
    expect(existsSync(memoryDir)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("ensureProjectMemoryDir rejects empty ids", () => {
    expect(() => ensureProjectMemoryDir("", "/tmp/root")).toThrow();
  });
});

describe("AGENT.md loader", () => {
  let root: string;
  let repo: string;
  let nested: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coreline-agent-loader-"));
    repo = join(root, "repo");
    nested = join(repo, "nested");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("findAgentMd returns files from cwd upward until .git", () => {
    writeFileSync(join(repo, "AGENT.md"), "repo agent");
    writeFileSync(join(nested, "CLAUDE.md"), "nested claude");
    writeFileSync(join(root, "AGENT.md"), "should not be read");

    const files = findAgentMd(nested);
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe(join(nested, "CLAUDE.md"));
    expect(files[0]!.content).toContain("nested claude");
    expect(files[1]!.path).toBe(join(repo, "AGENT.md"));
    expect(files[1]!.content).toContain("repo agent");
  });

  test("findAgentMd returns empty array when no files exist", () => {
    expect(findAgentMd(nested)).toEqual([]);
  });

  test("loadAgentMdContent joins file blocks with separators", () => {
    const files = [
      { path: join(nested, "AGENT.md"), content: "alpha" },
      { path: join(repo, "CLAUDE.md"), content: "beta" },
    ];
    const content = loadAgentMdContent(files);
    expect(content).toContain(`--- ${join(nested, "AGENT.md")} ---`);
    expect(content).toContain("alpha");
    expect(content).toContain(`--- ${join(repo, "CLAUDE.md")} ---`);
    expect(content).toContain("beta");
  });
});

describe("paths module default exports", () => {
  test("includes projectsDir", () => {
    expect(paths.projectsDir).toContain(".coreline-agent/projects");
  });
});
