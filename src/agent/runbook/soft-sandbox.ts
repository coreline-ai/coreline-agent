/**
 * Soft sandbox for runbook execution (Wave 10 P3a — F5 follow-up).
 *
 * Best-effort isolation without OS-level separation (no Docker /
 * firecracker / seccomp / user namespace). Activated by the opt-in
 * environment variable `RUNBOOK_SANDBOX_LEVEL=soft`. Provides:
 *   - tmpdir-scoped working directory (auto-cleanup)
 *   - environment scrubbing (HOME/USER/TOKEN/KEY/* removed, minimal PATH)
 *   - network-discouragement env hints (HTTP_PROXY → unreachable)
 *   - post-execution filesystem-escape detection (best-effort scan)
 *
 * NOT a security boundary against malicious input. Use only for
 * trusted-author runbooks. Hard isolation (Docker / firecracker) is
 * planned for Wave 11 + as the third level alongside `dry-run` and
 * `soft`.
 */

import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Minimal POSIX PATH injected into the sandboxed env. */
const SAFE_PATH = "/usr/bin:/bin";

/** Env var names always preserved (in addition to caller allowlist). */
const DEFAULT_KEEP_VARS = new Set<string>(["TMPDIR", "LANG", "LC_ALL", "TZ"]);

/**
 * Variables that must be stripped even if no other rule matched.
 * Anything that looks like a credential/identity is force-removed.
 */
const HARD_STRIP_VARS = new Set<string>([
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "MAIL",
  "PWD",
  "OLDPWD",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/** Substring patterns that, if present in a var name, force-remove it. */
const SENSITIVE_NAME_FRAGMENTS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "SSH_", "AWS_"];

export interface SoftSandboxConfig {
  /** Override sandbox temp dir (default: mkdtempSync under tmpdir()). */
  cwdOverride?: string;
  /** Cap stdout/stderr capture (chars). Default 2000 — caller-enforced. */
  outputCap?: number;
  /** Per-step timeout ms. Default 5000 — caller-enforced. */
  timeoutMs?: number;
  /** Allow inheriting these env vars (otherwise scrubbed). */
  envAllowlist?: string[];
  /** Skip network-block env hints when true. Default false. */
  allowNetwork?: boolean;
}

export interface SandboxedEnvResult {
  env: Record<string, string>;
  cwd: string;
  /** Cleanup function — caller must invoke after step finishes. */
  cleanup: () => void;
}

/**
 * Returns true when soft sandbox mode is currently active.
 * Only the exact value `"soft"` matches; anything else (incl. `"hard"`,
 * empty, or unset) returns false so legacy callers are unaffected.
 */
export function isSoftSandboxActive(): boolean {
  return process.env.RUNBOOK_SANDBOX_LEVEL === "soft";
}

/**
 * Build a scrubbed environment for a sandboxed step.
 *
 * Default behaviour:
 *   - drop everything except `DEFAULT_KEEP_VARS` + caller `allowlist`
 *   - force `PATH=/usr/bin:/bin`
 *   - force-remove any var matching `HARD_STRIP_VARS` or whose name
 *     contains a sensitive fragment (TOKEN / KEY / SECRET / …)
 *   - inject network-block hints (HTTP_PROXY=http://localhost:1, …)
 */
export function scrubEnv(
  allowlist: string[] = [],
  options: { allowNetwork?: boolean } = {},
): Record<string, string> {
  const allowed = new Set<string>([...DEFAULT_KEEP_VARS, ...allowlist]);
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!allowed.has(name)) continue;
    if (HARD_STRIP_VARS.has(name)) continue;
    if (SENSITIVE_NAME_FRAGMENTS.some((frag) => name.includes(frag))) continue;
    out[name] = value;
  }

  // Forced minimal PATH — overrides any inherited PATH even if allowlisted.
  out.PATH = SAFE_PATH;

  if (!options.allowNetwork) {
    // Best-effort: most CLI tools honour HTTP(S)_PROXY env. localhost:1 is
    // intentionally unreachable so accidental egress fails fast.
    out.HTTP_PROXY = "http://localhost:1";
    out.HTTPS_PROXY = "http://localhost:1";
    out.http_proxy = "http://localhost:1";
    out.https_proxy = "http://localhost:1";
    out.no_proxy = "*";
    out.NO_PROXY = "*";
  }

  return out;
}

/**
 * Create an isolated working directory + scrubbed env for a single step.
 * Caller MUST invoke the returned `cleanup` after the step completes.
 */
export function prepareSoftSandbox(
  config: SoftSandboxConfig = {},
): SandboxedEnvResult {
  const cwd =
    config.cwdOverride ??
    mkdtempSync(join(tmpdir(), "coreline-runbook-"));
  const env = scrubEnv(config.envAllowlist, {
    allowNetwork: config.allowNetwork,
  });

  // Replace TMPDIR with the sandbox cwd so tools that respect TMPDIR write
  // inside the sandbox by default.
  env.TMPDIR = cwd;

  const cleanup = () => {
    // Only auto-clean dirs we created (cwdOverride is caller-owned).
    if (config.cwdOverride) return;
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort — ignore (process may have files held open)
    }
  };

  return { env, cwd, cleanup };
}

/**
 * Best-effort detection of filesystem writes that escaped the sandbox.
 *
 * Caveats (documented in code AND in `docs/memkraft-wave789.md`):
 *   - other processes writing concurrently can produce false positives
 *   - mtime resolution is filesystem-dependent (some FS round to seconds)
 *   - we only scan a 1-deep listing of common targets to bound runtime
 *   - this is a heuristic, NOT a security control
 */
export function detectEscapedWrites(
  sandboxCwd: string,
  stepStartTime: number,
): string[] {
  const sandboxResolved = resolve(sandboxCwd);
  const candidates = new Set<string>([
    "/tmp",
    homedir(),
    tmpdir(),
  ]);

  const escaped: string[] = [];

  for (const dir of candidates) {
    const dirResolved = resolve(dir);
    // If the sandbox lives inside this candidate, we still scan it but
    // exclude entries that fall under `sandboxResolved`.
    let entries: string[];
    try {
      entries = readdirSync(dirResolved);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(dirResolved, entry);
      if (full === sandboxResolved) continue;
      if (full.startsWith(`${sandboxResolved}/`)) continue;

      try {
        const st = statSync(full);
        if (st.mtimeMs >= stepStartTime) {
          escaped.push(full);
        }
      } catch {
        // unreadable entries are ignored — not our problem
      }

      // bound work — never report more than 16 escapes per call
      if (escaped.length >= 16) return escaped;
    }
  }

  return escaped;
}
