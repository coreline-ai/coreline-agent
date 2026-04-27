import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import {
  cleanupParallelAgentWorktree,
  createParallelAgentWorktree,
  isGitRepository,
  ParallelAgentWorktreeError,
  resolveWorktreePath,
  validateWorktreeSlug,
} from "../src/agent/parallel/worktree.js";

function makeTempDir(prefix = "coreline-worktree-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "coreline@example.test"]);
  git(root, ["config", "user.name", "Coreline Test"]);
  writeFileSync(join(root, "README.md"), "# temp repo\n", "utf-8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "initial"]);
}

describe("parallel agent worktree helper", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("validates and normalizes safe slugs", () => {
    expect(validateWorktreeSlug("WS-A")).toBe("ws-a");
    expect(validateWorktreeSlug("feature-123")).toBe("feature-123");

    for (const unsafe of ["", "../escape", "a/b", "a\\b", ".git", "-bad", "bad-", "bad_slug"]) {
      expect(() => validateWorktreeSlug(unsafe)).toThrow(ParallelAgentWorktreeError);
    }
  });

  test("resolves worktree paths inside the configured root", () => {
    const worktreeRoot = join(root, "worktrees");
    const resolved = resolveWorktreePath(root, "ws-a", { rootDir: worktreeRoot });

    expect(resolved).toBe(join(worktreeRoot, "ws-a"));
    expect(relative(worktreeRoot, resolved).startsWith("..")).toBe(false);
    expect(() => resolveWorktreePath(root, "../escape", { rootDir: worktreeRoot })).toThrow(ParallelAgentWorktreeError);
  });

  test("detects git repositories and returns false for non-git directories", async () => {
    expect(await isGitRepository(root)).toBe(false);

    initRepo(root);
    expect(await isGitRepository(root)).toBe(true);
  });

  test("fails safely when create is requested outside a git repository", async () => {
    await expect(createParallelAgentWorktree({ cwd: root, slug: "ws-a", rootDir: join(root, "worktrees") })).rejects.toMatchObject({
      code: "not-git-repository",
    });
  });

  test("supports dry-run without creating a worktree", async () => {
    initRepo(root);
    const worktreeRoot = join(root, "worktrees");
    const result = await createParallelAgentWorktree({ cwd: root, slug: "ws-a", rootDir: worktreeRoot, dryRun: true });

    expect(result.created).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.branchName).toBe("coreline/parallel/ws-a");
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  test("creates and cleans up a git worktree without merge, push, or rebase", async () => {
    initRepo(root);
    const worktreeRoot = join(root, "worktrees");

    const created = await createParallelAgentWorktree({ cwd: root, slug: "ws-a", rootDir: worktreeRoot });
    expect(created.created).toBe(true);
    expect(existsSync(join(created.worktreePath, "README.md"))).toBe(true);
    expect(git(created.worktreePath, ["branch", "--show-current"])).toBe("coreline/parallel/ws-a");

    const worktreeList = git(root, ["worktree", "list", "--porcelain"]);
    expect(worktreeList).toContain(created.worktreePath);

    const cleaned = await cleanupParallelAgentWorktree({ cwd: root, slug: "ws-a", rootDir: worktreeRoot });
    expect(cleaned.removed).toBe(true);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  test("cleanup is idempotent for missing worktree path", async () => {
    initRepo(root);
    const result = await cleanupParallelAgentWorktree({ cwd: root, slug: "missing", rootDir: join(root, "worktrees") });

    expect(result.removed).toBe(false);
  });
});
