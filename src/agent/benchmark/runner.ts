import type { BenchmarkExpectedOutcome, BenchmarkResult, BenchmarkRunSummary, BenchmarkScenario } from "./types.js";

export interface BenchmarkRunnerOptions {
  now?: () => number;
  responder?: (scenario: BenchmarkScenario) => string | Promise<string>;
}

function defaultResponseFor(scenario: BenchmarkScenario): string {
  if (scenario.mockResponse !== undefined) {
    return scenario.mockResponse;
  }
  switch (scenario.expected) {
    case "success":
      return "success: completed";
    case "failure":
      return "failure: rejected";
    case "ambiguous":
      return "ambiguous: uncertain";
  }
}

export function classifyBenchmarkOutput(output: string): BenchmarkExpectedOutcome {
  const normalized = output.toLowerCase();
  if (/\b(ambiguous|uncertain|unknown|partial)\b/.test(normalized)) {
    return "ambiguous";
  }
  if (/\b(fail(?:ed|ure)?|error|reject(?:ed)?|denied|incorrect)\b/.test(normalized)) {
    return "failure";
  }
  if (/\b(success|succeeded|pass(?:ed)?|complete(?:d)?|correct)\b/.test(normalized)) {
    return "success";
  }
  return "ambiguous";
}

export async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  options: BenchmarkRunnerOptions = {},
): Promise<BenchmarkResult> {
  const now = options.now ?? Date.now;
  const startMs = now();
  try {
    const output = await (options.responder?.(scenario) ?? defaultResponseFor(scenario));
    const actual = classifyBenchmarkOutput(output);
    const elapsedMs = Math.max(0, now() - startMs);
    return {
      scenarioId: scenario.id,
      name: scenario.name,
      status: actual === scenario.expected ? "passed" : "failed",
      expected: scenario.expected,
      actual,
      output,
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Math.max(0, now() - startMs);
    const message = err instanceof Error ? err.message : String(err);
    return {
      scenarioId: scenario.id,
      name: scenario.name,
      status: scenario.expected === "failure" ? "passed" : "failed",
      expected: scenario.expected,
      actual: "failure",
      output: "",
      elapsedMs,
      error: message,
    };
  }
}

export async function runBenchmarkScenarios(
  scenarios: BenchmarkScenario[],
  options: BenchmarkRunnerOptions = {},
): Promise<BenchmarkRunSummary> {
  const now = options.now ?? Date.now;
  const startMs = now();
  const results: BenchmarkResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runBenchmarkScenario(scenario, options));
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    results,
    passed,
    failed,
    success: failed === 0,
    elapsedMs: Math.max(0, now() - startMs),
  };
}
