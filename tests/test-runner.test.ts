import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTestCommand, parseTestFailures, runTests } from "../src/agent/test-runner.js";
import { runTestFixLoopToCompletion } from "../src/agent/test-loop.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-test-runner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("test runner", () => {
  test("detects package.json test script first", () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    writeFileSync(join(cwd, "pyproject.toml"), "[tool.pytest.ini_options]\n");

    const detected = detectTestCommand(cwd);

    expect(detected?.command).toBe("bun run test");
    expect(detected?.runner).toBe("jest");
    expect(detected?.source).toBe("package-script");
  });

  test("detects bun, pytest, and make test commands", () => {
    const bunProject = tempProject();
    writeFileSync(join(bunProject, "bun.lock"), "");
    expect(detectTestCommand(bunProject)?.command).toBe("bun test");

    const pythonProject = tempProject();
    writeFileSync(join(pythonProject, "pyproject.toml"), "[project]\n");
    expect(detectTestCommand(pythonProject)?.command).toBe("pytest");

    const makeProject = tempProject();
    writeFileSync(join(makeProject, "Makefile"), "test:\n\t@echo ok\n");
    expect(detectTestCommand(makeProject)?.command).toBe("make test");
  });

  test("returns passed=true for successful command", async () => {
    const cwd = tempProject();
    const result = await runTests("bun -e \"console.log('ok')\"", cwd, undefined, { timeoutMs: 1_000 });

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  test("parses bun, jest, and pytest failures", () => {
    const failures = [
      ...parseTestFailures("(fail) tests/example.test.ts > does work", "bun"),
      ...parseTestFailures("FAIL tests/example.test.ts\n● renders page", "jest"),
      ...parseTestFailures("FAILED tests/test_app.py::test_home - AssertionError: boom", "pytest"),
    ];

    expect(failures.some((item) => item.runner === "bun" && item.file === "tests/example.test.ts")).toBe(true);
    expect(failures.some((item) => item.runner === "jest" && item.name === "renders page")).toBe(true);
    expect(failures.some((item) => item.runner === "pytest" && item.name === "test_home")).toBe(true);
  });

  test("returns parsed failures for failing command", async () => {
    const cwd = tempProject();
    const result = await runTests("bun -e \"console.error('FAILED tests/test_app.py::test_home - AssertionError: boom'); process.exit(1)\"", cwd, undefined, {
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.failures[0]?.runner).toBe("pytest");
  });

  test("times out long-running commands", async () => {
    const cwd = tempProject();
    const result = await runTests("bun -e \"setTimeout(() => {}, 2000)\"", cwd, undefined, { timeoutMs: 50 });

    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test("test fix loop stops after maxAttempts", async () => {
    const cwd = tempProject();
    let fixerCalls = 0;

    const { events, result } = await runTestFixLoopToCompletion({
      cwd,
      command: "bun -e \"console.error('FAIL tests/example.test.ts'); process.exit(1)\"",
      maxAttempts: 2,
      timeoutMs: 1_000,
      fixer: () => {
        fixerCalls += 1;
      },
    });

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.stoppedReason).toBe("max_attempts");
    expect(fixerCalls).toBe(1);
    expect(events.some((event) => event.type === "fix_requested")).toBe(true);
  });
});
