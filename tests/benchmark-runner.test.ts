import { describe, expect, test } from "bun:test";
import type { BenchmarkScenario } from "../src/agent/benchmark/index.js";
import {
  classifyBenchmarkOutput,
  runBenchmarkScenario,
  runBenchmarkScenarios,
} from "../src/agent/benchmark/index.js";

describe("benchmark runner", () => {
  test("classifies deterministic outputs", () => {
    expect(classifyBenchmarkOutput("success: completed correctly")).toBe("success");
    expect(classifyBenchmarkOutput("failure: rejected with error")).toBe("failure");
    expect(classifyBenchmarkOutput("uncertain partial result")).toBe("ambiguous");
  });

  test("runs a single mock scenario without external LLM calls", async () => {
    const scenario: BenchmarkScenario = {
      id: "basic-success",
      name: "Basic success",
      prompt: "Return success",
      expected: "success",
      mockResponse: "success: completed",
    };

    const result = await runBenchmarkScenario(scenario, { now: () => 100 });
    expect(result.status).toBe("passed");
    expect(result.actual).toBe("success");
  });

  test("summarizes pass and fail counts", async () => {
    const scenarios: BenchmarkScenario[] = [
      { id: "ok", name: "OK", prompt: "pass", expected: "success", mockResponse: "success" },
      { id: "bad", name: "Bad", prompt: "pass", expected: "success", mockResponse: "failure" },
      { id: "maybe", name: "Maybe", prompt: "ambiguous", expected: "ambiguous" },
    ];

    const summary = await runBenchmarkScenarios(scenarios, { now: () => 100 });
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.success).toBe(false);
  });

  test("treats responder errors as deterministic failure outcomes", async () => {
    const result = await runBenchmarkScenario(
      { id: "expected-failure", name: "Expected failure", prompt: "fail", expected: "failure" },
      { responder: () => { throw new Error("boom"); } },
    );

    expect(result.status).toBe("passed");
    expect(result.actual).toBe("failure");
    expect(result.error).toBe("boom");
  });
});
