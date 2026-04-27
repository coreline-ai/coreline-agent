/**
 * GrepTool — content search using ripgrep (rg).
 * Falls back to native grep if rg is not available.
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildTool } from "../types.js";
import type { ToolUseContext, ToolResult, PermissionResult } from "../types.js";

const DEFAULT_HEAD_LIMIT = 250;

interface GrepOutput {
  content: string;
  numMatches: number;
  truncated: boolean;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, signal });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", reject);
  });
}

export const GrepTool = buildTool<
  {
    pattern: string;
    path?: string;
    glob?: string;
    output_mode?: "content" | "files_with_matches" | "count";
    head_limit?: number;
  },
  GrepOutput
>({
  name: "Grep",
  description:
    "Search file contents using regex patterns (powered by ripgrep). " +
    "Supports output modes: content, files_with_matches, count.",
  maxResultSizeChars: 100_000,

  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Directory or file to search in"),
    glob: z.string().optional().describe("Glob filter (e.g. '*.ts')"),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .optional()
      .default("files_with_matches")
      .describe("Output mode"),
    head_limit: z.number().optional().describe("Max lines to return"),
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  checkPermissions: (): PermissionResult => ({ behavior: "allow" }),

  async call(input, context: ToolUseContext): Promise<ToolResult<GrepOutput>> {
    const searchPath = input.path ? resolve(context.cwd, input.path) : context.cwd;
    const limit = input.head_limit ?? DEFAULT_HEAD_LIMIT;
    const mode = input.output_mode ?? "files_with_matches";

    const args: string[] = [];

    // Output mode flags
    switch (mode) {
      case "files_with_matches":
        args.push("-l");
        break;
      case "count":
        args.push("-c");
        break;
      case "content":
        args.push("-n"); // line numbers
        break;
    }

    // Common flags
    args.push(
      "--no-heading",
      "--color", "never",
      "--max-columns", "300",
      "--glob", "!node_modules",
      "--glob", "!.git",
    );

    if (input.glob) {
      args.push("--glob", input.glob);
    }

    args.push(input.pattern, searchPath);

    try {
      const result = await runCommand("rg", args, context.cwd, context.abortSignal);

      const lines = result.stdout.split("\n").filter(Boolean);
      const truncated = lines.length > limit;
      const content = lines.slice(0, limit).join("\n");

      return {
        data: {
          content: content || (result.exitCode === 1 ? "No matches found" : result.stderr),
          numMatches: lines.length,
          truncated,
        },
      };
    } catch {
      // Fallback: try native grep
      try {
        const grepArgs = ["-rn", input.pattern, searchPath];
        const result = await runCommand("grep", grepArgs, context.cwd, context.abortSignal);
        const lines = result.stdout.split("\n").filter(Boolean);
        return {
          data: {
            content: lines.slice(0, limit).join("\n") || "No matches found",
            numMatches: lines.length,
            truncated: lines.length > limit,
          },
        };
      } catch {
        return {
          data: { content: "Error: neither rg nor grep available", numMatches: 0, truncated: false },
          isError: true,
        };
      }
    }
  },

  formatResult(output: GrepOutput, _toolUseId: string): string {
    let result = output.content;
    if (output.truncated) {
      result += `\n\n[Results truncated to ${DEFAULT_HEAD_LIMIT} lines. ${output.numMatches} total matches]`;
    }
    return result;
  },
});
