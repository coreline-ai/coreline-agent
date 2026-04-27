/**
 * Runbook sandbox executor (Wave 10 P2 — F5).
 *
 * Best-effort, opt-in sandboxed runner for individual runbook steps. Each
 * step is gated through `checkRunbookStepPermission` and then spawned via
 * `Bun.spawn(["sh", "-c", step])` with a wall-clock timeout (default 5s)
 * enforced through `setTimeout` + `proc.kill()` — the same pattern used
 * by `src/agent/test-runner.ts`.
 *
 * The function never throws: spawn failures, timeouts and permission
 * denials are surfaced as a `SandboxStepResult` with a status string the
 * caller can switch on.
 */

import { tmpdir } from "node:os";
import type { RunbookStepResult } from "./types.js";
import { checkRunbookStepPermission } from "./permission-gate.js";
import {
  detectEscapedWrites,
  isSoftSandboxActive,
  prepareSoftSandbox,
} from "./soft-sandbox.js";

export interface SandboxExecOptions {
  /** Per-step wall-clock timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Working directory for the spawned shell. Default `os.tmpdir()`. */
  cwd?: string;
}

export interface SandboxStepResult extends RunbookStepResult {
  durationMs?: number;
  exitCode?: number;
  stderr?: string;
  /** Soft-sandbox mode only: warnings such as filesystem-escape detection. */
  warning?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const STDOUT_MAX_CHARS = 2000;
const STDERR_MAX_CHARS = 2000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated]`;
}

/**
 * Execute a single bash step inside the sandbox. Never throws.
 */
export async function executeStepSandboxed(
  step: string,
  options: SandboxExecOptions = {},
): Promise<SandboxStepResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const gate = checkRunbookStepPermission(step);
  if (!gate.allowed) {
    return {
      step,
      status: "permission_denied",
      output: gate.reason ?? "denied",
    };
  }

  // Soft sandbox: when RUNBOOK_SANDBOX_LEVEL=soft, prepare an isolated tmp
  // cwd + scrubbed env. Otherwise fall back to the legacy behaviour
  // (caller cwd OR tmpdir, full process.env). This preserves the
  // backward-compatible RUNBOOK_SANDBOX_ENABLE=true contract.
  const softActive = isSoftSandboxActive();
  let cwd: string;
  let env: Record<string, string>;
  let cleanup: (() => void) | undefined;
  let sandboxCwdForCheck: string | undefined;

  if (softActive) {
    const sb = prepareSoftSandbox({
      cwdOverride: options.cwd,
      timeoutMs,
    });
    cwd = sb.cwd;
    env = sb.env;
    cleanup = sb.cleanup;
    sandboxCwdForCheck = sb.cwd;
  } else {
    cwd = options.cwd ?? tmpdir();
    env = { ...process.env } as Record<string, string>;
  }

  const startedAt = Date.now();

  try {
    let timedOut = false;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["sh", "-c", step], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (err) {
      return {
        step,
        status: "error",
        output: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const kill = () => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;

    try {
      const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
      const stderrPromise = new Response(proc.stderr as ReadableStream).text();
      const [code, outText, errText] = await Promise.all([
        proc.exited,
        stdoutPromise,
        stderrPromise,
      ]);
      exitCode = typeof code === "number" ? code : null;
      stdout = outText;
      stderr = errText;
    } catch (err) {
      clearTimeout(timer);
      return {
        step,
        status: "error",
        output: `read failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    const truncatedStdout = truncate(stdout, STDOUT_MAX_CHARS);
    const truncatedStderr = truncate(stderr, STDERR_MAX_CHARS);

    // Soft-mode post-execution check: scan common write targets for files
    // newer than `startedAt` outside the sandbox cwd. Best-effort only;
    // see `soft-sandbox.ts` for caveats.
    let warning: string | undefined;
    if (softActive && sandboxCwdForCheck) {
      const escaped = detectEscapedWrites(sandboxCwdForCheck, startedAt);
      if (escaped.length > 0) {
        warning = `Possible filesystem escape: ${escaped.slice(0, 3).join(", ")}`;
      }
    }

    if (timedOut) {
      return {
        step,
        status: "error",
        output: `Timed out after ${timeoutMs}ms`,
        durationMs,
        exitCode: exitCode ?? undefined,
        stderr: truncatedStderr,
        ...(warning ? { warning } : {}),
      };
    }

    if (exitCode === 0) {
      return {
        step,
        status: "success",
        output: truncatedStdout,
        durationMs,
        exitCode: 0,
        stderr: truncatedStderr,
        ...(warning ? { warning } : {}),
      };
    }

    return {
      step,
      status: "error",
      output:
        truncatedStdout || truncatedStderr || `exited with code ${exitCode ?? "?"}`,
      durationMs,
      exitCode: exitCode ?? undefined,
      stderr: truncatedStderr,
      ...(warning ? { warning } : {}),
    };
  } finally {
    cleanup?.();
  }
}
