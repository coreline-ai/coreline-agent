import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { PermissionEngine } from "../../permissions/engine.js";
import type { PermissionResult } from "../../permissions/types.js";
import type { CommandHookConfig, HookExecutionContext, HookInput, HookResult } from "../types.js";

const DEFAULT_COMMAND_HOOK_TIMEOUT_MS = 5_000;
const MAX_COMMAND_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT_CHARS = 4_096;
const MAX_OUTPUT_LIMIT_CHARS = 64_000;
const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];

const CREDENTIAL_ENV_PATTERN =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|BEARER|API[_-]?KEY|PRIVATE[_-]?KEY|SSH|OPENAI|ANTHROPIC|GOOGLE|GITHUB|GITLAB|AWS|AZURE|GCLOUD)/i;

export function commandHookDisabledResult(
  config: CommandHookConfig & { id: string },
): HookResult {
  return {
    hookId: config.id,
    hookName: config.name,
    type: config.type,
    blocking: false,
    durationMs: 0,
    error: "command hooks are disabled by default",
  };
}

export async function executeCommandHook(
  config: CommandHookConfig & { id: string },
  input: HookInput,
  signal?: AbortSignal,
  context?: HookExecutionContext,
): Promise<HookResult> {
  const started = Date.now();
  const timeoutResult = normalizeTimeoutMs(config.timeoutMs);
  if (!timeoutResult.ok) {
    return errorResult(config, started, timeoutResult.error);
  }

  if (!context) {
    return errorResult(config, started, "command hook permission context is required");
  }

  const permission = checkCommandHookPermission(config, context);
  if (permission.behavior === "deny") {
    return errorResult(
      config,
      started,
      `command hook permission denied${permission.reason ? `: ${permission.reason}` : ""}`,
    );
  }
  if (permission.behavior === "ask") {
    return errorResult(
      config,
      started,
      context.nonInteractive
        ? `command hook permission ask skipped in non-interactive mode${permission.reason ? `: ${permission.reason}` : ""}`
        : `command hook permission ask cannot run without an interactive approval adapter${permission.reason ? `: ${permission.reason}` : ""}`,
    );
  }

  const cwdResult = resolveCommandCwd(context.cwd, config.cwd);
  if (!cwdResult.ok) {
    return errorResult(config, started, cwdResult.error);
  }

  const envResult = buildCommandEnv(config);
  const stdoutLimit = normalizeOutputLimit(config.stdoutLimitChars);
  const stderrLimit = normalizeOutputLimit(config.stderrLimitChars);

  try {
    const commandResult = await runShellCommand({
      command: config.command,
      cwd: cwdResult.cwd,
      env: envResult.env,
      input,
      timeoutMs: timeoutResult.timeoutMs,
      stdoutLimit,
      stderrLimit,
      signal,
    });

    const metadata: Record<string, unknown> = {
      cwd: cwdResult.cwd,
      exitCode: commandResult.exitCode,
      signal: commandResult.signal,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      stdoutTruncated: commandResult.stdoutTruncated,
      stderrTruncated: commandResult.stderrTruncated,
      envKeys: Object.keys(envResult.env).sort(),
      strippedEnvKeys: envResult.strippedKeys.sort(),
    };

    if (commandResult.timedOut) {
      return errorResult(config, started, `hook timed out after ${timeoutResult.timeoutMs}ms`, metadata);
    }
    if (commandResult.aborted) {
      return errorResult(config, started, "hook aborted", metadata);
    }
    if (commandResult.exitCode !== 0) {
      return errorResult(config, started, `command exited with code ${commandResult.exitCode ?? "unknown"}`, metadata);
    }

    const parsed = parseCommandHookPayload(commandResult.stdout);
    return {
      hookId: config.id,
      hookName: config.name,
      type: config.type,
      blocking: Boolean(parsed?.blocking),
      durationMs: Date.now() - started,
      message: parsed?.message,
      metadata: {
        ...metadata,
        ...(parsed?.metadata ?? {}),
      },
    };
  } catch (err) {
    return errorResult(config, started, normalizeError(err));
  }
}

function checkCommandHookPermission(
  config: CommandHookConfig,
  context: HookExecutionContext,
): PermissionResult {
  if (!context.permissionContext) {
    return { behavior: "ask", reason: "missing permission context" };
  }
  return new PermissionEngine().check("Bash", { command: config.command }, context.permissionContext);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): { ok: true; timeoutMs: number } | { ok: false; error: string } {
  const effective = timeoutMs ?? DEFAULT_COMMAND_HOOK_TIMEOUT_MS;
  if (!Number.isFinite(effective) || effective <= 0) {
    return { ok: false, error: "command hook timeoutMs must be a positive finite number" };
  }
  return { ok: true, timeoutMs: Math.min(Math.trunc(effective), MAX_COMMAND_HOOK_TIMEOUT_MS) };
}

function normalizeOutputLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit == null || limit < 0) {
    return DEFAULT_OUTPUT_LIMIT_CHARS;
  }
  return Math.min(Math.trunc(limit), MAX_OUTPUT_LIMIT_CHARS);
}

function resolveCommandCwd(
  baseCwd: string,
  configuredCwd?: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  const base = resolveExistingPath(baseCwd);
  const requested = configuredCwd
    ? (isAbsolute(configuredCwd) ? resolve(configuredCwd) : resolve(base, configuredCwd))
    : base;
  const effective = existsSync(requested) ? resolveExistingPath(requested) : requested;

  if (!isPathInside(effective, base)) {
    return {
      ok: false,
      error: `command hook cwd must stay inside execution cwd: ${configuredCwd ?? requested}`,
    };
  }
  return { ok: true, cwd: effective };
}

function resolveExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isPathInside(candidate: string, base: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildCommandEnv(config: CommandHookConfig): { env: NodeJS.ProcessEnv; strippedKeys: string[] } {
  const allowlist = new Set([...DEFAULT_ENV_ALLOWLIST, ...(config.envAllowlist ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  const strippedKeys = new Set<string>();

  for (const key of allowlist) {
    if (isCredentialEnvKey(key)) {
      strippedKeys.add(key);
      continue;
    }
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }

  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!allowlist.has(key) || isCredentialEnvKey(key)) {
      strippedKeys.add(key);
      continue;
    }
    if (typeof value === "string") env[key] = value;
  }

  return { env, strippedKeys: [...strippedKeys] };
}

function isCredentialEnvKey(key: string): boolean {
  return CREDENTIAL_ENV_PATTERN.test(key);
}

interface RunShellCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: HookInput;
  timeoutMs: number;
  stdoutLimit: number;
  stderrLimit: number;
  signal?: AbortSignal;
}

interface RunShellCommandResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

function runShellCommand(options: RunShellCommandOptions): Promise<RunShellCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(shellCommand(), shellArgs(options.command), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 50);
      unrefTimer(forceKillTimer);
    }, options.timeoutMs);
    unrefTimer(timeout);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 50);
      unrefTimer(forceKillTimer);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = appendLimited(stdout, String(chunk), options.stdoutLimit);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = appendLimited(stderr, String(chunk), options.stderrLimit);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });

    child.on("close", (exitCode, signalName) => {
      cleanup();
      resolvePromise({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode,
        signal: signalName,
        timedOut,
        aborted,
      });
    });

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${JSON.stringify(options.input)}\n`);

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function shellCommand(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function shellArgs(command: string): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
}

function appendLimited(current: string, chunk: string, limit: number): { text: string; truncated: boolean } {
  if (limit === 0) return { text: "", truncated: chunk.length > 0 };
  if (current.length >= limit) return { text: current, truncated: chunk.length > 0 };
  const next = current + chunk;
  if (next.length <= limit) return { text: next, truncated: false };
  return { text: next.slice(0, limit), truncated: true };
}

function parseCommandHookPayload(stdout: string): { blocking?: boolean; message?: string; metadata?: Record<string, unknown> } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      blocking: typeof parsed.blocking === "boolean" ? parsed.blocking : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      metadata: isRecord(parsed.metadata) ? parsed.metadata : undefined,
    };
  } catch {
    return undefined;
  }
}

function errorResult(
  config: CommandHookConfig & { id: string },
  started: number,
  error: string,
  metadata?: Record<string, unknown>,
): HookResult {
  return {
    hookId: config.id,
    hookName: config.name,
    type: config.type,
    blocking: false,
    durationMs: Date.now() - started,
    error,
    metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
