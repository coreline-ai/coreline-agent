import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitTool } from "../src/tools/git/git-tool.js";
import type { ToolUseContext } from "../src/tools/types.js";

const tempDirs: string[] = [];

function tempProject(prefix = "coreline-git-tool-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const cwd = tempProject();
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "agent@example.com"]);
  git(cwd, ["config", "user.name", "Coreline Agent"]);
  writeFileSync(join(cwd, "README.md"), "hello\n", "utf-8");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

function context(cwd: string): ToolUseContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    nonInteractive: false,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitTool", () => {
  test("classifies read actions as allow and write actions as ask", () => {
    expect(GitTool.checkPermissions({ action: "status" }, context(process.cwd())).behavior).toBe("allow");
    expect(GitTool.checkPermissions({ action: "diff" }, context(process.cwd())).behavior).toBe("allow");
    expect(GitTool.checkPermissions({ action: "show" }, context(process.cwd())).behavior).toBe("allow");
    expect(GitTool.checkPermissions({ action: "stage", pathspec: "README.md" }, context(process.cwd())).behavior).toBe("ask");
    expect(GitTool.checkPermissions({ action: "apply", patch: "" }, context(process.cwd())).behavior).toBe("ask");
    expect(GitTool.checkPermissions({ action: "commit", message: "msg" }, context(process.cwd())).behavior).toBe("ask");
  });

  test("runs status, diff, log, and show in a temporary repository", async () => {
    const cwd = initRepo();
    writeFileSync(join(cwd, "README.md"), "hello\nworld\n", "utf-8");

    const status = await GitTool.call({ action: "status" }, context(cwd));
    const diff = await GitTool.call({ action: "diff", pathspec: "README.md" }, context(cwd));
    const log = await GitTool.call({ action: "log" }, context(cwd));
    const show = await GitTool.call({ action: "show", rev: "HEAD:README.md" }, context(cwd));

    expect(status.isError).toBeFalsy();
    expect(status.data.stdout).toContain("README.md");
    expect(diff.isError).toBeFalsy();
    expect(diff.data.stdout).toContain("+world");
    expect(log.isError).toBeFalsy();
    expect(log.data.stdout).toContain("initial");
    expect(show.isError).toBeFalsy();
    expect(show.data.stdout).toContain("hello");
  });

  test("returns a clear error for non-git directories", async () => {
    const cwd = tempProject();
    const result = await GitTool.call({ action: "status" }, context(cwd));

    expect(result.isError).toBe(true);
    expect(result.data.exitCode).toBe(128);
    expect(result.data.stderr).toContain("Not a git repository");
  });

  test("truncates huge git output deterministically", async () => {
    const cwd = initRepo();
    writeFileSync(join(cwd, "README.md"), `${"x".repeat(5000)}\n`, "utf-8");

    const result = await GitTool.call({ action: "diff", maxOutputChars: 200 }, context(cwd));

    expect(result.data.truncated).toBe(true);
    expect(result.data.stdout.length).toBeGreaterThanOrEqual(200);
    expect(result.data.stdout).toContain("git output truncated");
  });

  test("validates write action required fields without running git", async () => {
    const cwd = initRepo();

    const apply = await GitTool.call({ action: "apply" }, context(cwd));
    const stage = await GitTool.call({ action: "stage" }, context(cwd));
    const commit = await GitTool.call({ action: "commit" }, context(cwd));

    expect(apply.isError).toBe(true);
    expect(apply.data.stderr).toContain("patch");
    expect(stage.isError).toBe(true);
    expect(stage.data.stderr).toContain("pathspec");
    expect(commit.isError).toBe(true);
    expect(commit.data.stderr).toContain("message");
  });
});

import { PermissionEngine } from "../src/permissions/engine.js";

describe("GitTool permission engine integration", () => {
  test("allows read-only Git actions and asks for write actions", () => {
    const engine = new PermissionEngine();
    const ctx = { cwd: process.cwd(), mode: "default" as const, rules: [] };
    expect(engine.check("Git", { action: "status" }, ctx).behavior).toBe("allow");
    expect(engine.check("Git", { action: "diff" }, ctx).behavior).toBe("allow");
    expect(engine.check("Git", { action: "stage", pathspec: "README.md" }, ctx).behavior).toBe("ask");
    expect(engine.check("Git", { action: "commit", message: "x" }, ctx).behavior).toBe("ask");
    expect(engine.check("Git", { action: "unknown" }, ctx).behavior).toBe("deny");
  });
});
