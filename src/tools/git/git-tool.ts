/**
 * GitTool — structured git operations without shell command construction.
 *
 * Registration is intentionally left to the final integration workstream.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import { buildTool } from "../types.js";
import type { PermissionResult, ToolResult, ToolUseContext } from "../types.js";
import type { GitToolAction, GitToolInput, GitToolResult } from "../../agent/hardening-types.js";

const READ_ACTIONS = new Set<GitToolAction>(["status", "diff", "log", "show"]);
const WRITE_ACTIONS = new Set<GitToolAction>(["apply", "stage", "commit"]);
const DEFAULT_MAX_OUTPUT_CHARS = 120_000;

const GitToolInputSchema = z.object({
  action: z.enum(["status", "diff", "log", "show", "apply", "stage", "commit"]),
  pathspec: z.union([z.string(), z.array(z.string())]).optional(),
  rev: z.string().optional(),
  message: z.string().optional(),
  patch: z.string().optional(),
  maxOutputChars: z.number().int().min(1).max(500_000).optional(),
});

function normalizePathspec(pathspec: string | string[] | undefined): string[] {
  if (!pathspec) return [];
  const paths = Array.isArray(pathspec) ? pathspec : [pathspec];
  return paths.filter((path) => path.length > 0);
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[git output truncated: ${text.length - maxChars} chars omitted]`,
    truncated: true,
  };
}

interface ExecGitOptions {
  cwd: string;
  args: string[];
  stdin?: string;
  signal?: AbortSignal;
  maxOutputChars: number;
}

async function execGit(options: ExecGitOptions): Promise<Omit<GitToolResult, "action" | "cwd" | "command">> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;

    const proc = spawn("git", options.args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      signal: options.signal,
    });

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      const result = truncate(stdout, options.maxOutputChars);
      stdout = result.text;
      truncated ||= result.truncated;
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      const result = truncate(stderr, options.maxOutputChars);
      stderr = result.text;
      truncated ||= result.truncated;
    });

    proc.on("error", (error) => {
      resolve({
        stdout: "",
        stderr: error.message,
        exitCode: 127,
        durationMs: Date.now() - start,
        truncated: false,
      });
    });

    proc.on("close", (code) => {
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
        truncated,
      });
    });

    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin);
    }
    proc.stdin.end();
  });
}

function buildArgs(input: GitToolInput): { args: string[]; stdin?: string; error?: string } {
  const pathspec = normalizePathspec(input.pathspec);

  switch (input.action) {
    case "status":
      return { args: ["status", "--short", "--branch", ...(pathspec.length ? ["--", ...pathspec] : [])] };
    case "diff":
      return { args: ["diff", "--no-ext-diff", ...(input.rev ? [input.rev] : []), ...(pathspec.length ? ["--", ...pathspec] : [])] };
    case "log":
      return { args: ["log", "--oneline", "--decorate", "-n", "20", ...(input.rev ? [input.rev] : []), ...(pathspec.length ? ["--", ...pathspec] : [])] };
    case "show":
      return { args: ["show", "--no-ext-diff", input.rev ?? "HEAD", ...(pathspec.length ? ["--", ...pathspec] : [])] };
    case "apply":
      if (!input.patch) return { args: [], error: "Git apply requires a patch field." };
      return { args: ["apply", "--whitespace=nowarn", "-"], stdin: input.patch };
    case "stage":
      if (pathspec.length === 0) return { args: [], error: "Git stage requires pathspec." };
      return { args: ["add", "--", ...pathspec] };
    case "commit":
      if (!input.message?.trim()) return { args: [], error: "Git commit requires a non-empty message." };
      return { args: ["commit", "-m", input.message] };
  }
}

async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await execGit({ cwd, args: ["rev-parse", "--is-inside-work-tree"], signal, maxOutputChars: 1000 });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export const GitTool = buildTool<GitToolInput, GitToolResult>({
  name: "Git",
  description:
    "Run structured git actions without shell interpolation. " +
    "Read actions: status, diff, log, show. Write actions: apply, stage, commit.",
  inputSchema: GitToolInputSchema,
  maxResultSizeChars: DEFAULT_MAX_OUTPUT_CHARS,

  isReadOnly: (input) => READ_ACTIONS.has(input.action),
  isConcurrencySafe: (input) => READ_ACTIONS.has(input.action),

  checkPermissions: (input): PermissionResult => {
    if (READ_ACTIONS.has(input.action)) return { behavior: "allow" };
    if (WRITE_ACTIONS.has(input.action)) return { behavior: "ask", reason: `Git ${input.action} modifies repository state.` };
    return { behavior: "deny", reason: `Unknown git action: ${String(input.action)}` };
  },

  async call(input: GitToolInput, context: ToolUseContext): Promise<ToolResult<GitToolResult>> {
    const maxOutputChars = input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const built = buildArgs(input);
    if (built.error) {
      return {
        data: {
          action: input.action,
          stdout: "",
          stderr: built.error,
          exitCode: 2,
          durationMs: 0,
          truncated: false,
          cwd: context.cwd,
          command: ["git"],
        },
        isError: true,
      };
    }

    if (!(await isGitRepo(context.cwd, context.abortSignal))) {
      return {
        data: {
          action: input.action,
          stdout: "",
          stderr: `Not a git repository: ${context.cwd}`,
          exitCode: 128,
          durationMs: 0,
          truncated: false,
          cwd: context.cwd,
          command: ["git", ...built.args],
        },
        isError: true,
      };
    }

    const result = await execGit({
      cwd: context.cwd,
      args: built.args,
      stdin: built.stdin,
      signal: context.abortSignal,
      maxOutputChars,
    });

    return {
      data: {
        action: input.action,
        ...result,
        cwd: context.cwd,
        command: ["git", ...built.args],
      },
      isError: result.exitCode !== 0,
    };
  },

  formatResult(output: GitToolResult): string {
    const parts: string[] = [];
    if (output.stdout) parts.push(output.stdout);
    if (output.stderr) parts.push(`[stderr]\n${output.stderr}`);
    if (output.truncated) parts.push("[truncated]");
    if (output.exitCode !== 0) parts.push(`[Exit code: ${output.exitCode}]`);
    return parts.join("\n") || "[No git output]";
  },
});
