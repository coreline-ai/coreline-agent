import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export type ParallelAgentWorktreeErrorCode =
  | "invalid-cwd"
  | "invalid-slug"
  | "path-traversal"
  | "not-git-repository"
  | "target-exists"
  | "git-command-failed";

export interface ParallelAgentWorktreePathOptions {
  readonly rootDir?: string;
  readonly prefix?: string;
}

export interface CreateParallelAgentWorktreeInput extends ParallelAgentWorktreePathOptions {
  readonly cwd: string;
  readonly slug: string;
  readonly baseRef?: string;
  readonly branchName?: string;
  readonly dryRun?: boolean;
}

export interface CleanupParallelAgentWorktreeInput extends ParallelAgentWorktreePathOptions {
  readonly cwd: string;
  readonly slug: string;
  readonly force?: boolean;
  readonly removeDirectoryFallback?: boolean;
}

export interface ParallelAgentWorktreeResult {
  readonly cwd: string;
  readonly slug: string;
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly branchName: string;
  readonly dryRun: boolean;
  readonly created: boolean;
}

export interface ParallelAgentWorktreeCleanupResult {
  readonly cwd: string;
  readonly slug: string;
  readonly worktreePath: string;
  readonly removed: boolean;
}

export class ParallelAgentWorktreeError extends Error {
  readonly code: ParallelAgentWorktreeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ParallelAgentWorktreeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ParallelAgentWorktreeError";
    this.code = code;
    this.details = details;
  }
}

function assertCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) {
    throw new ParallelAgentWorktreeError("invalid-cwd", "Worktree cwd is required");
  }
  return resolve(trimmed);
}

function ensureWithinRoot(rootDir: string, targetPath: string, label: string): string {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }

  throw new ParallelAgentWorktreeError("path-traversal", `Refusing unsafe worktree ${label}: ${targetPath}`, {
    rootDir: root,
    targetPath: target,
  });
}

function defaultWorktreeRoot(cwd: string, prefix = "coreline-parallel-worktrees"): string {
  const repoRoot = assertCwd(cwd);
  return resolve(dirname(repoRoot), `${basename(repoRoot)}.${prefix}`);
}

function safeBranchName(slug: string): string {
  return `coreline/parallel/${slug}`;
}

async function runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ParallelAgentWorktreeError("git-command-failed", `git ${args.join(" ")} failed: ${message}`, {
      cwd,
      args: [...args],
    });
  }
}

export function validateWorktreeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) {
    throw new ParallelAgentWorktreeError("invalid-slug", "Worktree slug is required");
  }

  if (normalized.includes("\0") || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new ParallelAgentWorktreeError("path-traversal", `Refusing unsafe worktree slug: ${slug}`);
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new ParallelAgentWorktreeError(
      "invalid-slug",
      "Worktree slug must use 1-63 lowercase letters, numbers, or hyphens and cannot start/end with hyphen",
      { slug },
    );
  }

  return normalized;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const repoRoot = assertCwd(cwd);
  try {
    const result = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    });
    return String(result.stdout ?? "").trim() === "true";
  } catch {
    return false;
  }
}

export function resolveWorktreePath(cwd: string, slug: string, options: ParallelAgentWorktreePathOptions = {}): string {
  const repoRoot = assertCwd(cwd);
  const safeSlug = validateWorktreeSlug(slug);
  const rootDir = options.rootDir ? resolve(options.rootDir) : defaultWorktreeRoot(repoRoot, options.prefix);
  const worktreePath = resolve(rootDir, safeSlug);
  return ensureWithinRoot(rootDir, worktreePath, "path");
}

export async function createParallelAgentWorktree(
  input: CreateParallelAgentWorktreeInput,
): Promise<ParallelAgentWorktreeResult> {
  const cwd = assertCwd(input.cwd);
  const slug = validateWorktreeSlug(input.slug);
  const worktreePath = resolveWorktreePath(cwd, slug, input);
  const baseRef = input.baseRef?.trim() || "HEAD";
  const branchName = input.branchName?.trim() || safeBranchName(slug);

  if (!(await isGitRepository(cwd))) {
    throw new ParallelAgentWorktreeError("not-git-repository", `Not a git repository: ${cwd}`, { cwd });
  }

  if (existsSync(worktreePath)) {
    throw new ParallelAgentWorktreeError("target-exists", `Worktree path already exists: ${worktreePath}`, {
      worktreePath,
    });
  }

  if (input.dryRun) {
    return { cwd, slug, worktreePath, baseRef, branchName, dryRun: true, created: false };
  }

  await runGit(cwd, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
  return { cwd, slug, worktreePath, baseRef, branchName, dryRun: false, created: true };
}

export async function cleanupParallelAgentWorktree(
  input: CleanupParallelAgentWorktreeInput,
): Promise<ParallelAgentWorktreeCleanupResult> {
  const cwd = assertCwd(input.cwd);
  const slug = validateWorktreeSlug(input.slug);
  const worktreePath = resolveWorktreePath(cwd, slug, input);

  if (!existsSync(worktreePath)) {
    return { cwd, slug, worktreePath, removed: false };
  }

  if (!(await isGitRepository(cwd))) {
    throw new ParallelAgentWorktreeError("not-git-repository", `Not a git repository: ${cwd}`, { cwd });
  }

  const args = ["worktree", "remove"];
  if (input.force ?? true) {
    args.push("--force");
  }
  args.push(worktreePath);

  try {
    await runGit(cwd, args);
  } catch (error) {
    if (!input.removeDirectoryFallback) {
      throw error;
    }
    await rm(worktreePath, { recursive: true, force: true });
  }

  return { cwd, slug, worktreePath, removed: true };
}
