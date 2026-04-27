import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TestRunnerKind = "bun" | "jest" | "pytest" | "make" | "unknown";

export interface TestCommand {
  command: string;
  cwd: string;
  runner: TestRunnerKind;
  source: "package-script" | "bun-project" | "pyproject" | "makefile" | "explicit";
}

export interface TestFailure {
  runner: TestRunnerKind;
  file?: string;
  line?: number;
  name?: string;
  message: string;
  raw: string;
}

export interface TestRunResult {
  command: string;
  cwd: string;
  passed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  output: string;
  failures: TestFailure[];
}

export interface RunTestsOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FAILURES = 20;

export function detectTestCommand(cwd: string): TestCommand | null {
  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    const packageJson = readJsonFile(packageJsonPath);
    const testScript = packageJson?.scripts?.test;
    if (typeof testScript === "string" && testScript.trim()) {
      return { command: "bun run test", cwd, runner: inferRunner(testScript), source: "package-script" };
    }
  }

  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb")) || existsSync(packageJsonPath)) {
    return { command: "bun test", cwd, runner: "bun", source: "bun-project" };
  }

  if (existsSync(join(cwd, "pyproject.toml"))) {
    return { command: "pytest", cwd, runner: "pytest", source: "pyproject" };
  }

  if (existsSync(join(cwd, "Makefile")) || existsSync(join(cwd, "makefile"))) {
    return { command: "make test", cwd, runner: "make", source: "makefile" };
  }

  return null;
}

export async function runTests(
  command: string | TestCommand,
  cwd: string = typeof command === "string" ? process.cwd() : command.cwd,
  signal?: AbortSignal,
  options: RunTestsOptions = {},
): Promise<TestRunResult> {
  const commandText = typeof command === "string" ? command : command.command;
  const runner = typeof command === "string" ? inferRunner(commandText) : command.runner;
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  let aborted = false;

  const proc = Bun.spawn(["sh", "-lc", commandText], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });

  const kill = () => {
    try {
      proc.kill();
    } catch {
      // Process may already be gone.
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  const abortHandler = () => {
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
  const output = [stdout, stderr].filter(Boolean).join("\n");
  const normalizedExitCode = typeof exitCode === "number" ? exitCode : null;

  return {
    command: commandText,
    cwd,
    passed: !timedOut && !aborted && normalizedExitCode === 0,
    timedOut: timedOut || aborted,
    exitCode: normalizedExitCode,
    durationMs,
    stdout,
    stderr,
    output,
    failures: parseTestFailures(output, runner),
  };
}

export function parseTestFailures(output: string, runner: TestRunnerKind = "unknown"): TestFailure[] {
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    const candidates = [parseBunFailure(trimmed), parseJestFailure(trimmed), parsePytestFailure(trimmed), parseAssertionLocation(trimmed, runner)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const key = `${candidate.runner}:${candidate.file ?? ""}:${candidate.line ?? ""}:${candidate.name ?? ""}:${candidate.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push(candidate);
      if (failures.length >= MAX_FAILURES) return failures;
    }
  }

  if (failures.length === 0 && output.trim()) {
    const generic = parseGenericFailure(output, runner);
    if (generic) failures.push(generic);
  }

  return failures;
}

function readJsonFile(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function inferRunner(command: string): TestRunnerKind {
  if (/\bpytest\b/.test(command)) return "pytest";
  if (/\bjest\b/.test(command)) return "jest";
  if (/\bbun\s+(run\s+)?test\b/.test(command) || /\bbun\s+test\b/.test(command)) return "bun";
  if (/\bmake\s+test\b/.test(command)) return "make";
  return "unknown";
}

function parseBunFailure(line: string): TestFailure | null {
  const match = line.match(/^\(?fail\)?\s+(.+?)(?:\s*>\s*(.+))?$/i);
  if (!match) return null;
  const file = cleanFile(match[1]);
  const name = match[2]?.trim();
  return { runner: "bun", file, name, message: name ? `Bun test failed: ${name}` : `Bun test failed: ${file}`, raw: line };
}

function parseJestFailure(line: string): TestFailure | null {
  const failMatch = line.match(/^FAIL\s+(.+)$/);
  if (failMatch) {
    const file = cleanFile(failMatch[1]);
    return { runner: "jest", file, message: `Jest suite failed: ${file}`, raw: line };
  }
  const testMatch = line.match(/^[●✕]\s+(.+)$/u);
  if (testMatch) {
    const name = testMatch[1]?.trim();
    return { runner: "jest", name, message: `Jest test failed: ${name}`, raw: line };
  }
  return null;
}

function parsePytestFailure(line: string): TestFailure | null {
  const failedMatch = line.match(/^FAILED\s+(.+?)(?:::([^\s]+))?(?:\s+-\s+(.+))?$/);
  if (failedMatch) {
    return {
      runner: "pytest",
      file: cleanFile(failedMatch[1]),
      name: failedMatch[2]?.trim(),
      message: failedMatch[3]?.trim() || `Pytest failed: ${failedMatch[1]}`,
      raw: line,
    };
  }
  return null;
}

function parseAssertionLocation(line: string, runner: TestRunnerKind): TestFailure | null {
  const match = line.match(/^([^\s:]+\.(?:test|spec)?[jt]sx?|[^\s:]+\.py):(\d+)(?::\d+)?:\s*(.+)$/);
  if (!match) return null;
  return {
    runner: runner === "unknown" ? (match[1]?.endsWith(".py") ? "pytest" : "unknown") : runner,
    file: cleanFile(match[1]),
    line: Number(match[2]),
    message: match[3]?.trim() || "Test assertion failed",
    raw: line,
  };
}

function parseGenericFailure(output: string, runner: TestRunnerKind): TestFailure | null {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /error|fail|assert/i.test(item));
  if (!line) return null;
  return { runner, message: line.slice(0, 500), raw: line };
}

function cleanFile(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/^['"]|['"]$/g, "");
  return cleaned || undefined;
}
