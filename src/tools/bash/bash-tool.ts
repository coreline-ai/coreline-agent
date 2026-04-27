/**
 * BashTool — execute shell commands.
 * Reference: Claude Code BashTool (streaming progress via async generator).
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import { buildTool } from "../types.js";
import type { ToolUseContext, ToolResult, PermissionResult } from "../types.js";
import { classifyBashCommand } from "../../permissions/classifier.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const MAX_OUTPUT = 200_000; // chars

interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BashOutput> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env },
      signal,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Truncate if too large
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n[output truncated]";
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n[output truncated]";
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}

export const BashTool = buildTool<
  { command: string; timeout?: number },
  BashOutput
>({
  name: "Bash",
  description:
    "Execute a bash command and return its output. " +
    "Commands timeout after 120 seconds by default.",
  maxResultSizeChars: MAX_OUTPUT,

  inputSchema: z.object({
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
  }),

  isReadOnly: (input) => {
    const result = classifyBashCommand(input.command);
    return result.behavior === "allow";
  },

  isConcurrencySafe: (input) => {
    const result = classifyBashCommand(input.command);
    return result.behavior === "allow"; // read-only commands are safe
  },

  checkPermissions: (input): PermissionResult => {
    return classifyBashCommand(input.command);
  },

  async call(input, context: ToolUseContext): Promise<ToolResult<BashOutput>> {
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT;
    const result = await execCommand(
      input.command,
      context.cwd,
      timeoutMs,
      context.abortSignal,
    );

    return {
      data: result,
      isError: result.exitCode !== 0,
    };
  },

  formatResult(output: BashOutput, _toolUseId: string): string {
    const parts: string[] = [];

    if (output.stdout) parts.push(output.stdout);
    if (output.stderr) parts.push(`[stderr]\n${output.stderr}`);

    if (output.timedOut) {
      parts.push(`[Command timed out after ${output.durationMs}ms]`);
    } else if (output.exitCode !== 0) {
      parts.push(`[Exit code: ${output.exitCode}]`);
    }

    return parts.join("\n") || "[No output]";
  },
});
