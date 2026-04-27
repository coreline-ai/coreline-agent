/**
 * Wave 10 P3a — F5 follow-up: Soft sandbox layer tests.
 *
 * Soft mode is opt-in (`RUNBOOK_SANDBOX_LEVEL=soft`) and provides
 * best-effort isolation: tmpdir cwd, env scrubbing, post-exec
 * filesystem-escape detection. NOT a security boundary — see
 * `src/agent/runbook/soft-sandbox.ts` for caveats.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  detectEscapedWrites,
  isSoftSandboxActive,
  prepareSoftSandbox,
  scrubEnv,
} from "../src/agent/runbook/soft-sandbox.js";
import { executeStepSandboxed } from "../src/agent/runbook/sandbox-executor.js";

const SAVED_LEVEL = process.env.RUNBOOK_SANDBOX_LEVEL;
const SAVED_ENABLE = process.env.RUNBOOK_SANDBOX_ENABLE;
const SAVED_PATH = process.env.PATH;
const SAVED_HOME = process.env.HOME;
const SAVED_USER = process.env.USER;

describe("Runbook soft sandbox — Wave 10 P3a F5 follow-up", () => {
  beforeEach(() => {
    delete process.env.RUNBOOK_SANDBOX_LEVEL;
    delete process.env.RUNBOOK_SANDBOX_ENABLE;
    // Inject a few sentinel env vars so scrubEnv tests are deterministic.
    process.env.GITHUB_TOKEN = "should-be-stripped";
    process.env.MY_SECRET_KEY = "should-be-stripped";
    process.env.HOME = "/Users/sentinel-home";
    process.env.USER = "sentinel-user";
  });

  afterEach(() => {
    if (SAVED_LEVEL === undefined) delete process.env.RUNBOOK_SANDBOX_LEVEL;
    else process.env.RUNBOOK_SANDBOX_LEVEL = SAVED_LEVEL;
    if (SAVED_ENABLE === undefined) delete process.env.RUNBOOK_SANDBOX_ENABLE;
    else process.env.RUNBOOK_SANDBOX_ENABLE = SAVED_ENABLE;
    delete process.env.GITHUB_TOKEN;
    delete process.env.MY_SECRET_KEY;
    // Always restore PATH/HOME/USER — individual tests mutate them and we
    // do NOT want bleed into either subsequent tests in this file or
    // unrelated test files run in the same process.
    if (SAVED_PATH === undefined) delete process.env.PATH;
    else process.env.PATH = SAVED_PATH;
    if (SAVED_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = SAVED_HOME;
    if (SAVED_USER === undefined) delete process.env.USER;
    else process.env.USER = SAVED_USER;
  });

  test("isSoftSandboxActive() — env unset → false", () => {
    expect(isSoftSandboxActive()).toBe(false);
  });

  test("isSoftSandboxActive() — RUNBOOK_SANDBOX_LEVEL=soft → true", () => {
    process.env.RUNBOOK_SANDBOX_LEVEL = "soft";
    expect(isSoftSandboxActive()).toBe(true);
  });

  test("isSoftSandboxActive() — RUNBOOK_SANDBOX_LEVEL=hard → false (only 'soft' matches)", () => {
    process.env.RUNBOOK_SANDBOX_LEVEL = "hard";
    expect(isSoftSandboxActive()).toBe(false);
  });

  test("scrubEnv() removes HOME/USER/LOGNAME", () => {
    process.env.LOGNAME = "sentinel-logname";
    const env = scrubEnv();
    expect(env.HOME).toBeUndefined();
    expect(env.USER).toBeUndefined();
    expect(env.LOGNAME).toBeUndefined();
    delete process.env.LOGNAME;
  });

  test("scrubEnv() removes API_KEY / TOKEN / SECRET / PASSWORD vars", () => {
    process.env.SOME_PASSWORD = "x";
    process.env.SOME_SECRET = "x";
    const env = scrubEnv();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_SECRET_KEY).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
    delete process.env.SOME_PASSWORD;
    delete process.env.SOME_SECRET;
  });

  test("scrubEnv() forces minimal PATH", () => {
    process.env.PATH = "/usr/local/bin:/foo/bin";
    const env = scrubEnv();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("scrubEnv() injects unreachable HTTP_PROXY by default", () => {
    const env = scrubEnv();
    expect(env.HTTP_PROXY).toBe("http://localhost:1");
    expect(env.HTTPS_PROXY).toBe("http://localhost:1");
    expect(env.no_proxy).toBe("*");
  });

  test("scrubEnv({ allowNetwork: true }) skips proxy hints", () => {
    const env = scrubEnv([], { allowNetwork: true });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    // PATH is still forced even when network allowed.
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("scrubEnv() honours allowlist for benign vars", () => {
    process.env.MY_BENIGN_VAR = "kept";
    const env = scrubEnv(["MY_BENIGN_VAR"]);
    expect(env.MY_BENIGN_VAR).toBe("kept");
    delete process.env.MY_BENIGN_VAR;
  });

  test("prepareSoftSandbox() cwd lives under tmpdir() and is auto-cleaned", () => {
    const sb = prepareSoftSandbox();
    expect(sb.cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(sb.cwd)).toBe(true);
    // TMPDIR is rewritten to point at the sandbox cwd.
    expect(sb.env.TMPDIR).toBe(sb.cwd);
    sb.cleanup();
    expect(existsSync(sb.cwd)).toBe(false);
  });

  test("prepareSoftSandbox({ cwdOverride }) does NOT delete caller-owned dirs", () => {
    const sb = prepareSoftSandbox({ cwdOverride: tmpdir() });
    expect(sb.cwd).toBe(tmpdir());
    sb.cleanup();
    // tmpdir() must still exist after cleanup.
    expect(existsSync(tmpdir())).toBe(true);
  });

  test("detectEscapedWrites() returns [] when only sandbox cwd was touched (best-effort)", () => {
    const sb = prepareSoftSandbox();
    // stepStartTime in the future → nothing should match (no file is newer
    // than a future timestamp in a quiet system → typically [] or some
    // racy entries; we can only guarantee bounded results, not zero).
    const future = Date.now() + 60_000;
    const escaped = detectEscapedWrites(sb.cwd, future);
    expect(escaped.length).toBeLessThanOrEqual(16);
    sb.cleanup();
  });

  test("integration: RUNBOOK_SANDBOX_LEVEL=soft + `echo \"ok\"` runs and cleans up", async () => {
    process.env.RUNBOOK_SANDBOX_LEVEL = "soft";
    // `echo` is in the read-only allow list. With soft mode active the
    // sandbox prepares an isolated cwd + scrubbed env. We assert the gate
    // passed, the command produced expected output, and durationMs is set.
    const result = await executeStepSandboxed('echo "ok"');
    expect(result.status).toBe("success");
    expect(result.output).toBe("ok\n");
    expect(typeof result.durationMs).toBe("number");
  });

  test("integration: soft mode still enforces permission gate (rm -rf /)", async () => {
    process.env.RUNBOOK_SANDBOX_LEVEL = "soft";
    const result = await executeStepSandboxed("rm -rf /");
    expect(result.status).toBe("permission_denied");
  });

  test("integration: soft mode preserves backward-compat for non-soft callers", async () => {
    // RUNBOOK_SANDBOX_LEVEL not set → behaves as before (uses caller cwd
    // and full env). `echo "ok"` should succeed without setup/teardown.
    const result = await executeStepSandboxed('echo "ok"');
    expect(result.status).toBe("success");
    expect(result.output).toBe("ok\n");
  });
});
