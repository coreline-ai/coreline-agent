import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHookEngine } from "../src/hooks/index.js";
import type { HookExecutionContext } from "../src/hooks/index.js";
import { runToolCalls } from "../src/tools/orchestration.js";
import { buildTool } from "../src/tools/types.js";

function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hookContext(
  cwd: string,
  opts: { nonInteractive?: boolean; mode?: "default" | "acceptAll" | "denyAll" } = {},
): HookExecutionContext {
  return {
    cwd,
    nonInteractive: opts.nonInteractive ?? false,
    permissionContext: {
      cwd,
      mode: opts.mode ?? "default",
      rules: [],
    },
  };
}

async function executePreToolCommand(
  engine: ReturnType<typeof createHookEngine>,
  cwd: string,
  context = hookContext(cwd),
) {
  return await engine.execute(
    "PreTool",
    { event: "PreTool", toolName: "Echo", input: { message: "hello" } },
    undefined,
    context,
  );
}

const EchoTool = buildTool({
  name: "Echo",
  description: "Echo a message",
  inputSchema: z.object({ message: z.string() }),
  async call(input) {
    return { data: input.message };
  },
  formatResult(output) {
    return String(output);
  },
  isConcurrencySafe: () => true,
});

async function collectToolResults(
  engine: ReturnType<typeof createHookEngine>,
  cwd: string,
  tool = EchoTool,
) {
  const results = [];
  for await (const result of runToolCalls(
    [{ type: "tool_use", id: "tc_1", name: tool.name, input: { message: "hello" } }],
    new Map([[tool.name, tool]]),
    {
      cwd,
      abortSignal: new AbortController().signal,
      nonInteractive: false,
      hookEngine: engine,
      permissionContext: {
        cwd,
        mode: "acceptAll",
        rules: [],
      },
    },
  )) {
    results.push(result);
  }
  return results;
}

describe("command hooks safe runner", () => {
  test("command hooks are disabled by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-command-disabled-"));
    try {
      const marker = join(dir, "marker");
      const engine = createHookEngine();
      engine.register({
        type: "command",
        event: "PreTool",
        command: `printf ran > ${sh(marker)}`,
        timeoutMs: 1_000,
      });

      const results = await executePreToolCommand(engine, dir, hookContext(dir, { mode: "acceptAll" }));
      expect(results).toHaveLength(1);
      expect(results[0]?.blocking).toBe(false);
      expect(results[0]?.error).toContain("disabled");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env allowlist keeps safe values and strips credential-like keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-command-env-"));
    try {
      const engine = createHookEngine({ enableCommandHooks: true });
      engine.register({
        type: "command",
        event: "PreTool",
        command: 'printf "%s|%s" "${SAFE_HOOK_ENV:-}" "${OPENAI_API_KEY:-}"',
        timeoutMs: 1_000,
        env: {
          SAFE_HOOK_ENV: "visible",
          OPENAI_API_KEY: "secret",
        },
        envAllowlist: ["SAFE_HOOK_ENV", "OPENAI_API_KEY"],
      });

      const results = await executePreToolCommand(engine, dir);
      expect(results[0]?.error).toBeUndefined();
      expect(results[0]?.metadata?.stdout).toBe("visible|");
      expect(results[0]?.metadata?.envKeys).toContain("SAFE_HOOK_ENV");
      expect(results[0]?.metadata?.envKeys).not.toContain("OPENAI_API_KEY");
      expect(results[0]?.metadata?.strippedEnvKeys).toContain("OPENAI_API_KEY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("timeout and command failures are captured as fail-open HookResult errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-command-timeout-"));
    try {
      const engine = createHookEngine({ enableCommandHooks: true });
      engine.register({
        id: "slow",
        type: "command",
        event: "PreTool",
        command: "sleep 1",
        timeoutMs: 20,
      });
      engine.register({
        id: "exit-code",
        type: "command",
        event: "PreTool",
        command: "printf 123456789; printf abcdef >&2; exit 7",
        timeoutMs: 1_000,
        stdoutLimitChars: 4,
        stderrLimitChars: 3,
      });

      const results = await executePreToolCommand(engine, dir, hookContext(dir, { mode: "acceptAll" }));
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ hookId: "slow", blocking: false });
      expect(results[0]?.error).toContain("timed out");
      expect(results[1]).toMatchObject({ hookId: "exit-code", blocking: false });
      expect(results[1]?.error).toContain("command exited with code 7");
      expect(results[1]?.metadata).toMatchObject({
        exitCode: 7,
        stdout: "1234",
        stderr: "abc",
        stdoutTruncated: true,
        stderrTruncated: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cwd is constrained to the execution cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-command-root-"));
    const outside = mkdtempSync(join(tmpdir(), "coreline-command-outside-"));
    try {
      const marker = join(outside, "marker");
      const engine = createHookEngine({ enableCommandHooks: true });
      engine.register({
        type: "command",
        event: "PreTool",
        command: `printf ran > ${sh(marker)}`,
        cwd: outside,
        timeoutMs: 1_000,
      });

      const results = await executePreToolCommand(engine, root, hookContext(root, { mode: "acceptAll" }));
      expect(results[0]?.blocking).toBe(false);
      expect(results[0]?.error).toContain("cwd must stay inside");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("non-interactive ask decisions skip command execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-command-ask-"));
    try {
      const marker = join(dir, "marker");
      const engine = createHookEngine({ enableCommandHooks: true });
      engine.register({
        type: "command",
        event: "PreTool",
        command: `rm -rf ${sh(join(dir, "missing"))}; printf ran > ${sh(marker)}`,
        timeoutMs: 1_000,
      });

      const results = await executePreToolCommand(engine, dir, hookContext(dir, { nonInteractive: true }));
      expect(results[0]?.blocking).toBe(false);
      expect(results[0]?.error).toContain("non-interactive");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("command hooks in tool orchestration", () => {
  test("PreTool blocking command hook prevents tool execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-command-pretool-"));
    try {
      let called = 0;
      const CountingTool = buildTool({
        ...EchoTool,
        async call(input) {
          called += 1;
          return { data: input.message };
        },
      });
      const engine = createHookEngine({ enableCommandHooks: true });
      engine.register({
        id: "cmd-block",
        name: "cmd-block",
        type: "command",
        event: "PreTool",
        command: 'printf %s \'{"blocking":true,"message":"blocked by command"}\'',
        timeoutMs: 1_000,
      });

      const results = await collectToolResults(engine, dir, CountingTool);
      expect(called).toBe(0);
      expect(results[0]?.result.isError).toBe(true);
      expect(results[0]?.formattedResult).toContain("Tool blocked by hook cmd-block: blocked by command");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PostTool blocking command hook annotates without undoing tool execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-command-posttool-"));
    try {
      const engine = createHookEngine({ enableCommandHooks: true });
      engine.register({
        id: "cmd-post",
        name: "cmd-post",
        type: "command",
        event: "PostTool",
        command: 'printf %s \'{"blocking":true,"message":"audit annotation"}\'',
        timeoutMs: 1_000,
      });

      const results = await collectToolResults(engine, dir);
      expect(results[0]?.result.isError).toBeUndefined();
      expect(results[0]?.formattedResult).toContain("hello");
      expect(results[0]?.formattedResult).toContain(
        "PostTool hook cmd-post returned blocking after tool execution: audit annotation",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
