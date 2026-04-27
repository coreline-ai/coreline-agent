import { describe, expect, test } from "bun:test";
import { BasicEvaluator } from "../src/agent/plan-execute/evaluator.js";
import type { Task } from "../src/agent/plan-execute/types.js";

const task: Task = {
  id: "task-1",
  description: "Inspect the repository",
  dependsOn: [],
  status: "pending",
};

describe("plan-execute evaluator", () => {
  test("marks clear success text as success", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(task, "Task completed successfully.");

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
  });

  test("marks explicit failure objects as failure", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(task, {
      success: false,
      reason: "permission denied",
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("permission denied");
  });

  test("prefers explicit verification metadata over ambiguous text", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(task, {
      verification: {
        status: "passed",
        strategy: "deterministic",
        summary: "tests passed",
      },
      output: "I inspected it and here is the summary.",
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.strategy).toBe("deterministic");
    expect(result.reason).toBe("tests passed");
  });

  test("keeps explicit deterministic failure even when the text looks successful", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(task, {
      verification: {
        status: "failed",
        strategy: "deterministic",
        summary: "tests failed",
      },
      output: "Task completed successfully.",
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failure");
    expect(result.strategy).toBe("deterministic");
    expect(result.reason).toBe("tests failed");
  });

  test("uses exit-code verification hints before text fallback", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(
      {
        ...task,
        verificationHint: {
          contract: "exit_code",
          expectedExitCode: 0,
        },
      },
      {
        exitCode: 0,
        output: "still ambiguous looking text",
      },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.strategy).toBe("deterministic");
    expect(result.contract).toBe("exit_code");
  });

  test("uses artifact verification hints for file/path outputs", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(
      {
        ...task,
        verificationHint: {
          contract: "artifact",
          artifactKind: "file",
          artifactLabel: "dist/index.js",
        },
      },
      {
        path: "dist/index.js",
        summary: "built the artifact",
      },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.strategy).toBe("deterministic");
    expect(result.contract).toBe("artifact");
  });

  test("uses assertion verification hints for textual checks", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(
      {
        ...task,
        verificationHint: {
          contract: "assertion",
          assertionText: "All checks passed",
          assertionTarget: "result",
        },
      },
      {
        output: "All checks passed after the fix",
      },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.strategy).toBe("deterministic");
    expect(result.contract).toBe("assertion");
  });

  test("treats unclear output as ambiguous pass", async () => {
    const evaluator = new BasicEvaluator();
    const result = await evaluator.evaluate(task, "I inspected it and here is the summary.");

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("ambiguous");
  });
});
