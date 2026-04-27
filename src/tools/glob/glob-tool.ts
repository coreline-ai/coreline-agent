/**
 * GlobTool — file search by name pattern.
 * Reference: Claude Code GlobTool (199 LOC, simplest tool pattern).
 */

import { z } from "zod";
import fg from "fast-glob";
import { buildTool } from "../types.js";
import type { ToolUseContext, ToolResult, PermissionResult } from "../types.js";
import { resolve } from "node:path";
import { relative } from "node:path";

const MAX_RESULTS = 200;

function shouldRetryRecursively(pattern: string): boolean {
  return /^[*]\.[^/]+$/.test(pattern);
}

interface GlobOutput {
  filenames: string[];
  numFiles: number;
  truncated: boolean;
  durationMs: number;
}

export const GlobTool = buildTool<{ pattern: string; path?: string }, GlobOutput>({
  name: "Glob",
  description:
    "Fast file pattern matching. Supports glob patterns like '**/*.ts'. " +
    "Returns matching file paths sorted by modification time.",
  maxResultSizeChars: 100_000,

  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match files (e.g. '**/*.ts')"),
    path: z.string().optional().describe("Directory to search in (defaults to cwd)"),
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  checkPermissions: (): PermissionResult => ({ behavior: "allow" }),

  async call(
    input: { pattern: string; path?: string },
    context: ToolUseContext,
  ): Promise<ToolResult<GlobOutput>> {
    const executeGlob = async (): Promise<ToolResult<GlobOutput>> => {
    const start = Date.now();
    const searchDir = input.path ? resolve(context.cwd, input.path) : context.cwd;

    try {
      const runGlob = (pattern: string) =>
        fg(pattern, {
          cwd: searchDir,
          absolute: false,
          onlyFiles: true,
          dot: false,
          ignore: ["**/node_modules/**", "**/.git/**"],
          stats: true,
        });

      let files = await runGlob(input.pattern);

      if (files.length === 0 && shouldRetryRecursively(input.pattern)) {
        files = await runGlob(`**/${input.pattern}`);
      }

      // Sort by modification time (newest first)
      files.sort((a, b) => {
        const aTime = a.stats?.mtimeMs ?? 0;
        const bTime = b.stats?.mtimeMs ?? 0;
        return bTime - aTime;
      });

      const truncated = files.length > MAX_RESULTS;
      const filenames = files.slice(0, MAX_RESULTS).map((f) =>
        typeof f === "string" ? f : f.path,
      );

      return {
        data: {
          filenames,
          numFiles: filenames.length,
          truncated,
          durationMs: Date.now() - start,
        },
      };
    } catch (err) {
      return {
        data: { filenames: [], numFiles: 0, truncated: false, durationMs: Date.now() - start },
        isError: true,
      };
    }
    };

    if (context.toolCache) {
      return await context.toolCache.getOrSet(
        {
          cwd: context.cwd,
          toolName: "Glob",
          input,
          paths: [input.path ?? context.cwd],
        },
        executeGlob,
      );
    }

    return await executeGlob();
  },

  formatResult(output: GlobOutput, _toolUseId: string): string {
    if (output.numFiles === 0) return "No files found";
    let result = output.filenames.join("\n");
    if (output.truncated) {
      result += `\n\n[Results truncated. Showing ${output.numFiles} of more files]`;
    }
    return result;
  },
});
