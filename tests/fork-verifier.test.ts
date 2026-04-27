import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectVerificationCommands,
  formatVerificationReport,
  runVerification,
} from "../src/agent/fork-verifier.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createFixture(options: {
  typecheck?: { behavior?: "pass" | "fail" | "sleep"; delayMs?: number };
  build?: { behavior?: "pass" | "fail" | "sleep"; delayMs?: number };
  test?: { behavior?: "pass" | "fail" | "sleep"; delayMs?: number };
} = {}): { cwd: string; logPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "coreline-fork-verifier-"));
  const logPath = join(cwd, "run.log");
  const scriptPath = join(cwd, "verify-fixture.js");
  const script = [
    "const fs = require('node:fs');",
    "const [, , logPath, label, behavior = 'pass', delayMs = '0'] = process.argv;",
    "const delay = Number(delayMs);",
    "fs.appendFileSync(logPath, `${label}\\n`);",
    "if (behavior === 'fail') {",
    "  console.error(`${label} failed`);",
    "  process.exit(1);",
    "}",
    "console.log(`${label} ok`);",
    "if (behavior === 'sleep' && delay > 0) {",
    "  setTimeout(() => process.exit(0), delay);",
    "} else {",
    "  process.exit(0);",
    "}",
    "",
  ].join("\n");
  writeFileSync(scriptPath, script);

  const makeScript = (label: string, config?: { behavior?: "pass" | "fail" | "sleep"; delayMs?: number }) => {
    const behavior = config?.behavior ?? "pass";
    const delayMs = String(config?.delayMs ?? 0);
    return `node ${shellQuote(scriptPath)} ${shellQuote(logPath)} ${shellQuote(label)} ${shellQuote(behavior)} ${shellQuote(delayMs)}`;
  };

  const packageJson = {
    private: true,
    scripts: {
      typecheck: makeScript("typecheck", options.typecheck),
      build: makeScript("build", options.build),
      test: makeScript("test", options.test),
    },
  };
  writeFileSync(join(cwd, "package.json"), JSON.stringify(packageJson, null, 2));
  return { cwd, logPath };
}

describe("fork verifier", () => {
  test("detects typecheck/build/test scripts from package.json in the expected order", () => {
    const fixture = createFixture();
    const commands = detectVerificationCommands(fixture.cwd);

    expect(commands.map((command) => command.name)).toEqual(["typecheck", "build", "test"]);
    expect(commands.map((command) => command.command)).toEqual([
      "bun run typecheck",
      "bun run build",
      "bun run test",
    ]);
    expect(commands.every((command) => command.source === "package-script")).toBe(true);
    rmSync(fixture.cwd, { recursive: true, force: true });
  });

  test("runs detected commands sequentially and fails fast on the first failure", async () => {
    const fixture = createFixture({
      typecheck: { behavior: "pass" },
      build: { behavior: "fail" },
      test: { behavior: "pass" },
    });

    const report = await runVerification({ cwd: fixture.cwd }, new AbortController().signal);

    expect(report.status).toBe("failed");
    expect(report.passed).toBe(false);
    expect(report.failedCommand).toBe("build");
    expect(report.commands).toHaveLength(2);
    expect(report.commands[0]?.status).toBe("passed");
    expect(report.commands[1]?.status).toBe("failed");
    expect(report.commands[1]?.stderrSummary.length ?? 0).toBeGreaterThan(0);
    expect(report.summary).toContain("failed");

    const log = readFileSync(fixture.logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    expect(log).toEqual(["typecheck", "build"]);
    rmSync(fixture.cwd, { recursive: true, force: true });
  });

  test("marks a slow command as timed out and stops the report there", async () => {
    const fixture = createFixture({
      typecheck: { behavior: "pass" },
      build: { behavior: "pass" },
      test: { behavior: "sleep", delayMs: 2_000 },
    });

    const report = await runVerification({ cwd: fixture.cwd, timeoutMs: 750 }, new AbortController().signal);

    expect(report.status).toBe("failed");
    expect(report.passed).toBe(false);
    expect(report.failedCommand).toBe("test");
    expect(report.commands).toHaveLength(3);
    expect(report.commands[2]?.status).toBe("timeout");
    expect(report.commands[2]?.timedOut).toBe(true);
    expect(report.commands[2]?.summary).toContain("timed out");

    const log = readFileSync(fixture.logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    expect(log).toEqual(["typecheck", "build", "test"]);
    rmSync(fixture.cwd, { recursive: true, force: true });
  });

  test("returns a blocked report when no verification commands are declared", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "coreline-fork-verifier-empty-"));
    const report = await runVerification({ cwd }, new AbortController().signal);

    expect(report.status).toBe("blocked");
    expect(report.passed).toBe(false);
    expect(report.commands).toHaveLength(0);
    expect(report.detectedCommands).toHaveLength(0);
    expect(report.blockedReason).toContain("No verification commands");
    expect(formatVerificationReport(report)).toContain("blocked_reason:");
    rmSync(cwd, { recursive: true, force: true });
  });
});
