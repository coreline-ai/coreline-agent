import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ParallelAgentTaskRecord,
  ParallelAgentTaskResult,
  ParallelAgentTaskRuntimeHandle,
} from "./parallel/types.js";

export type VerificationCommandSource = "package-script" | "explicit";

export interface VerificationCommand {
  name: string;
  command: string;
  source: VerificationCommandSource;
  timeoutMs?: number;
}

export type CommandResultStatus = "passed" | "failed" | "timeout" | "aborted" | "blocked";

export interface CommandResult {
  name: string;
  command: string;
  source: VerificationCommandSource;
  status: CommandResultStatus;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutSummary: string;
  stderrSummary: string;
  summary: string;
}

export interface VerificationRequest {
  cwd: string;
  commands?: Array<string | VerificationCommand>;
  timeoutMs?: number;
  failFast?: boolean;
}

export interface VerificationReport {
  cwd: string;
  status: "passed" | "failed" | "blocked" | "aborted";
  passed: boolean;
  aborted: boolean;
  blockedReason?: string;
  detectedCommands: VerificationCommand[];
  commands: CommandResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  failedCommand?: string;
}

export interface ForkVerifierTaskWorkOptions {
  request: VerificationRequest;
}

export type ForkVerifierTaskWork = (
  task: ParallelAgentTaskRecord,
  handle: ParallelAgentTaskRuntimeHandle,
) => Promise<ParallelAgentTaskResult>;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_SUMMARY_LENGTH = 220;
const MAX_REPORT_LINE_LENGTH = 180;

function readJsonFile(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function truncate(text: string, limit: number = MAX_SUMMARY_LENGTH): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function summarizeStream(text: string): string {
  return truncate(text, MAX_REPORT_LINE_LENGTH);
}

function buildCommand(command: string, name: string, source: VerificationCommandSource, timeoutMs?: number): VerificationCommand {
  return {
    name,
    command,
    source,
    timeoutMs,
  };
}

function normalizeCommand(value: string | VerificationCommand, fallbackName: string): VerificationCommand {
  if (typeof value === "string") {
    return buildCommand(value, fallbackName, "explicit");
  }
  return {
    name: value.name?.trim() || fallbackName,
    command: value.command.trim(),
    source: value.source,
    timeoutMs: value.timeoutMs,
  };
}

function commandSummary(
  name: string,
  status: CommandResultStatus,
  durationMs: number,
  exitCode: number | null,
): string {
  const base = `${name} ${status}`;
  if (status === "passed") {
    return `${base} in ${durationMs}ms`;
  }
  if (status === "timeout" || status === "aborted") {
    return `${base} after ${durationMs}ms`;
  }
  const exit = exitCode === null ? "no exit code" : `exit ${exitCode}`;
  return `${base} (${exit}) in ${durationMs}ms`;
}

function createBlockedReport(request: VerificationRequest, reason: string): VerificationReport {
  const timestamp = new Date().toISOString();
  return {
    cwd: request.cwd,
    status: "blocked",
    passed: false,
    aborted: false,
    blockedReason: reason,
    detectedCommands: [],
    commands: [],
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    summary: reason,
  };
}

async function runShellCommand(
  command: VerificationCommand,
  cwd: string,
  signal: AbortSignal | undefined,
  defaultTimeoutMs: number,
): Promise<CommandResult> {
  const startedAt = Date.now();
  let timedOut = false;
  let aborted = false;
  const timeoutMs = command.timeoutMs ?? defaultTimeoutMs;

  if (signal?.aborted) {
    const durationMs = Date.now() - startedAt;
    const status: CommandResultStatus = "aborted";
    return {
      name: command.name,
      command: command.command,
      source: command.source,
      status,
      exitCode: null,
      timedOut: false,
      aborted: true,
      durationMs,
      stdout: "",
      stderr: "",
      stdoutSummary: "",
      stderrSummary: "",
      summary: commandSummary(command.name, status, durationMs, null),
    };
  }

  const proc = Bun.spawn(["sh", "-lc", command.command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const kill = (): void => {
    try {
      proc.kill();
    } catch {
      // Best effort.
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  const abortHandler = (): void => {
    aborted = true;
    kill();
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);

  clearTimeout(timeout);
  signal?.removeEventListener("abort", abortHandler);

  const durationMs = Date.now() - startedAt;
  const normalizedExitCode = typeof exitCode === "number" ? exitCode : null;
  const status: CommandResultStatus = aborted
    ? "aborted"
    : timedOut
      ? "timeout"
      : normalizedExitCode === 0
        ? "passed"
        : "failed";

  const stdoutSummary = summarizeStream(stdout);
  const stderrSummary = summarizeStream(stderr);

  return {
    name: command.name,
    command: command.command,
    source: command.source,
    status,
    exitCode: normalizedExitCode,
    timedOut,
    aborted,
    durationMs,
    stdout,
    stderr,
    stdoutSummary,
    stderrSummary,
    summary:
      status === "passed"
        ? `${command.name} passed in ${durationMs}ms`
        : status === "timeout"
          ? `${command.name} timed out after ${durationMs}ms`
          : status === "aborted"
            ? `${command.name} aborted after ${durationMs}ms`
            : `${command.name} failed with exit code ${normalizedExitCode ?? "unknown"} in ${durationMs}ms`,
  };
}

function normalizeVerificationCommands(commands: Array<string | VerificationCommand>): VerificationCommand[] {
  return commands.map((command, index) => normalizeCommand(command, `command-${index + 1}`));
}

export function detectVerificationCommands(cwd: string): VerificationCommand[] {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  const packageJson = readJsonFile(packageJsonPath);
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return [];
  }

  const detected: VerificationCommand[] = [];
  const candidates = ["typecheck", "build", "test"] as const;
  for (const scriptName of candidates) {
    const script = (scripts as Record<string, unknown>)[scriptName];
    if (typeof script !== "string" || !script.trim()) {
      continue;
    }
    detected.push(buildCommand(`bun run ${scriptName}`, scriptName, "package-script"));
  }

  return detected;
}

export async function runVerification(
  request: VerificationRequest,
  signal?: AbortSignal,
): Promise<VerificationReport> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const detectedCommands = request.commands?.length
    ? normalizeVerificationCommands(request.commands)
    : detectVerificationCommands(request.cwd);

  if (detectedCommands.length === 0) {
    return createBlockedReport(request, "No verification commands detected in package.json");
  }

  const results: CommandResult[] = [];
  const defaultTimeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const failFast = request.failFast ?? true;
  let passed = true;
  let aborted = false;
  let status: VerificationReport["status"] = "passed";
  let failedCommand: string | undefined;

  for (const command of detectedCommands) {
    const result = await runShellCommand(command, request.cwd, signal, defaultTimeoutMs);
    results.push(result);

    if (result.status === "aborted") {
      aborted = true;
      passed = false;
      status = "aborted";
      failedCommand = command.name;
      break;
    }

    if (result.status !== "passed") {
      passed = false;
      status = "failed";
      failedCommand = command.name;
      if (failFast) {
        break;
      }
    }
  }

  const finishedAtDate = new Date();
  const durationMs = Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime());
  const commandNames = results.map((result) => `${result.name}:${result.status}`).join(", ");
  const summary =
    status === "passed"
      ? `Verification passed in ${durationMs}ms: ${commandNames || "no commands"}`
      : status === "aborted"
        ? `Verification aborted in ${durationMs}ms after ${failedCommand ?? "an in-flight command"}`
        : `Verification failed in ${durationMs}ms at ${failedCommand ?? "an unknown command"}`;

  return {
    cwd: request.cwd,
    status,
    passed,
    aborted,
    detectedCommands,
    commands: results,
    startedAt,
    finishedAt: finishedAtDate.toISOString(),
    durationMs,
    summary,
    failedCommand,
  };
}

export function formatVerificationReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push(`VERIFICATION_${report.status.toUpperCase()}`);
  lines.push(`cwd: ${report.cwd}`);
  lines.push(`duration_ms: ${report.durationMs}`);
  lines.push(`passed: ${report.passed}`);
  lines.push(`aborted: ${report.aborted}`);

  if (report.blockedReason) {
    lines.push(`blocked_reason: ${report.blockedReason}`);
  }

  if (report.failedCommand) {
    lines.push(`failed_command: ${report.failedCommand}`);
  }

  if (report.detectedCommands.length > 0) {
    lines.push("detected_commands:");
    for (const command of report.detectedCommands) {
      lines.push(`- ${command.name}: ${command.command}`);
    }
  }

  if (report.commands.length > 0) {
    lines.push("results:");
    for (const result of report.commands) {
      lines.push(`- ${result.name}: ${result.status} (${result.durationMs}ms)`);
      if (result.stdoutSummary) {
        lines.push(`  stdout: ${result.stdoutSummary}`);
      }
      if (result.stderrSummary) {
        lines.push(`  stderr: ${result.stderrSummary}`);
      }
      if (result.status !== "passed") {
        lines.push(`  summary: ${result.summary}`);
      }
    }
  }

  lines.push(`summary: ${report.summary}`);
  return lines.join("\n");
}

export function createForkVerifierTaskWork(
  request: VerificationRequest,
): ForkVerifierTaskWork {
  return async (_task, handle) => {
    const report = await runVerification(request, handle.abortController.signal);
    return {
      summary: report.summary,
      finalText: formatVerificationReport(report),
      usedTools: report.detectedCommands.map((command) => command.name),
    };
  };
}
