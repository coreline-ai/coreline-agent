import { detectTestCommand, runTests, type TestCommand, type TestRunResult } from "./test-runner.js";

export type TestFixLoopEventType = "start" | "test_result" | "fix_requested" | "finished";

export interface TestFixLoopEvent {
  type: TestFixLoopEventType;
  attempt: number;
  message: string;
  result?: TestRunResult;
}

export interface TestFixLoopResult {
  passed: boolean;
  attempts: number;
  results: TestRunResult[];
  stoppedReason: "passed" | "max_attempts" | "no_test_command" | "fixer_unavailable" | "aborted";
}

export interface TestFixLoopOptions {
  cwd: string;
  command?: string | TestCommand;
  maxAttempts?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  fixer?: (context: { attempt: number; result: TestRunResult }) => Promise<void | boolean> | void | boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function* runTestFixLoop(options: TestFixLoopOptions): AsyncGenerator<TestFixLoopEvent, TestFixLoopResult, void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const detectedCommand = options.command ?? detectTestCommand(options.cwd);
  const results: TestRunResult[] = [];

  if (!detectedCommand) {
    const result = { passed: false, attempts: 0, results, stoppedReason: "no_test_command" as const };
    yield { type: "finished", attempt: 0, message: "No test command detected." };
    return result;
  }

  const commandText = typeof detectedCommand === "string" ? detectedCommand : detectedCommand.command;
  yield { type: "start", attempt: 0, message: `Starting test fix loop: ${commandText}` };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      const result = { passed: false, attempts: attempt - 1, results, stoppedReason: "aborted" as const };
      yield { type: "finished", attempt: attempt - 1, message: "Test fix loop aborted." };
      return result;
    }

    const testResult = await runTests(detectedCommand, options.cwd, options.signal, { timeoutMs: options.timeoutMs });
    results.push(testResult);
    yield {
      type: "test_result",
      attempt,
      message: testResult.passed ? "Tests passed." : `Tests failed with ${testResult.failures.length} parsed failure(s).`,
      result: testResult,
    };

    if (testResult.passed) {
      const result = { passed: true, attempts: attempt, results, stoppedReason: "passed" as const };
      yield { type: "finished", attempt, message: "Test fix loop completed successfully.", result: testResult };
      return result;
    }

    if (attempt >= maxAttempts) break;
    if (!options.fixer) {
      const result = { passed: false, attempts: attempt, results, stoppedReason: "fixer_unavailable" as const };
      yield { type: "finished", attempt, message: "Tests failed and no fixer callback was provided.", result: testResult };
      return result;
    }

    yield { type: "fix_requested", attempt, message: "Requesting fix for failed test run.", result: testResult };
    const shouldContinue = await options.fixer({ attempt, result: testResult });
    if (shouldContinue === false) {
      const result = { passed: false, attempts: attempt, results, stoppedReason: "fixer_unavailable" as const };
      yield { type: "finished", attempt, message: "Fixer stopped the test fix loop.", result: testResult };
      return result;
    }
  }

  const lastResult = results[results.length - 1];
  const result = { passed: false, attempts: results.length, results, stoppedReason: "max_attempts" as const };
  yield { type: "finished", attempt: results.length, message: "Maximum test attempts reached.", result: lastResult };
  return result;
}

export async function runTestFixLoopToCompletion(options: TestFixLoopOptions): Promise<{ events: TestFixLoopEvent[]; result: TestFixLoopResult }> {
  const events: TestFixLoopEvent[] = [];
  const iterator = runTestFixLoop(options);
  while (true) {
    const next = await iterator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
