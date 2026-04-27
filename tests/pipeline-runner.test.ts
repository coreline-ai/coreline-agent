/**
 * Pipeline runner tests — verifies sequential handoff, failure policies,
 * abort propagation, and context injection.
 */

import { describe, expect, test } from "bun:test";
import { runPipeline } from "../src/agent/pipeline-runner.js";
import type { PipelineExecutor, PipelineStageExecResult } from "../src/agent/pipeline-runner.js";
import type { PipelineRequest } from "../src/agent/pipeline-types.js";

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function makeExecutor(
  responses: Array<Partial<PipelineStageExecResult> | "fail" | "timeout">,
): PipelineExecutor {
  let callIndex = 0;
  const prompts: string[] = [];

  const executor: PipelineExecutor & { prompts: string[] } = Object.assign(
    async (req: { prompt: string }): Promise<PipelineStageExecResult> => {
      prompts.push(req.prompt);
      const spec = responses[callIndex++];

      if (spec === "fail") {
        return {
          status: "failed",
          text: "",
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          provider: "mock",
          error: "stage failed",
        };
      }
      if (spec === "timeout") {
        return {
          status: "timeout",
          text: "",
          usage: EMPTY_USAGE,
          provider: "mock",
          error: "stage timed out",
        };
      }

      return {
        status: "completed",
        text: `result-${callIndex}`,
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        provider: "mock",
        model: "mock-model",
        ...spec,
      };
    },
    { prompts },
  );

  return executor;
}

describe("runPipeline", () => {
  test("TC-E.1: 3-stage pipeline with context injection", async () => {
    const executor = makeExecutor([{}, {}, {}]);
    const request: PipelineRequest = {
      stages: [
        { prompt: "stage-1 task" },
        { prompt: "stage-2 task" },
        { prompt: "stage-3 task" },
      ],
      goal: "test pipeline",
    };

    const result = await runPipeline(request, executor);

    expect(result.completedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(3);
    expect(result.finalText).toBe("result-3");

    // Stage 1 gets goal but no previous result
    expect(executor.prompts[0]).toContain("[Pipeline Goal] test pipeline");
    expect(executor.prompts[0]).toContain("stage-1 task");
    expect(executor.prompts[0]).not.toContain("Previous stage result");

    // Stage 2 gets stage 1's result
    expect(executor.prompts[1]).toContain("Previous stage result:");
    expect(executor.prompts[1]).toContain("result-1");
    expect(executor.prompts[1]).toContain("stage-2 task");

    // Stage 3 gets stage 2's result
    expect(executor.prompts[2]).toContain("result-2");
    expect(executor.prompts[2]).toContain("stage-3 task");

    // Usage aggregated
    expect(result.totalUsage.inputTokens).toBe(15);
    expect(result.totalUsage.outputTokens).toBe(30);
  });

  test("TC-E.2: stage failure + stop policy → remaining skipped", async () => {
    const executor = makeExecutor([{}, "fail"]);
    const request: PipelineRequest = {
      stages: [
        { prompt: "stage-1" },
        { prompt: "stage-2 will fail" },
        { prompt: "stage-3 should be skipped" },
      ],
      onStageFailure: "stop",
    };

    const result = await runPipeline(request, executor);

    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.stages[0]!.status).toBe("completed");
    expect(result.stages[1]!.status).toBe("failed");
    expect(result.stages[2]!.status).toBe("skipped");
    expect(result.finalText).toBe("result-1"); // last completed
  });

  test("TC-E.3: stage failure + skip policy → next stage runs", async () => {
    const executor = makeExecutor(["fail", {}]);
    const request: PipelineRequest = {
      stages: [
        { prompt: "stage-1 will fail" },
        { prompt: "stage-2 should run" },
      ],
      onStageFailure: "skip",
    };

    const result = await runPipeline(request, executor);

    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.stages[0]!.status).toBe("failed");
    expect(result.stages[1]!.status).toBe("completed");
    // Stage 2 should NOT have previous result (stage 1 failed)
    expect(executor.prompts[1]).not.toContain("Previous stage result");
  });

  test("TC-E.4: abort signal → current + remaining aborted", async () => {
    const controller = new AbortController();
    let callCount = 0;

    const executor: PipelineExecutor = async () => {
      callCount++;
      if (callCount === 2) {
        controller.abort();
        throw new Error("aborted mid-execution");
      }
      return {
        status: "completed",
        text: `ok-${callCount}`,
        usage: EMPTY_USAGE,
        provider: "mock",
      };
    };

    const result = await runPipeline(
      { stages: [{ prompt: "s1" }, { prompt: "s2" }, { prompt: "s3" }] },
      executor,
      controller.signal,
    );

    // s1 completed, s2 aborted (threw), s3 aborted (signal)
    expect(result.stages[0]!.status).toBe("completed");
    expect(result.stages[1]!.status).toBe("aborted");
    expect(result.stages[2]!.status).toBe("aborted");
  });

  test("TC-E.5: per-stage usage tracking", async () => {
    const executor = makeExecutor([
      { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
      { usage: { inputTokens: 5, outputTokens: 15, totalTokens: 20 } },
    ]);

    const result = await runPipeline(
      { stages: [{ prompt: "a" }, { prompt: "b" }] },
      executor,
    );

    expect(result.stages[0]!.usage.inputTokens).toBe(10);
    expect(result.stages[1]!.usage.inputTokens).toBe(5);
    expect(result.totalUsage.inputTokens).toBe(15);
    expect(result.totalUsage.outputTokens).toBe(35);
  });

  test("TC-E.6: empty pipeline → success with no stages", async () => {
    const executor = makeExecutor([]);
    const result = await runPipeline({ stages: [] }, executor);

    expect(result.stages).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.completedCount).toBe(0);
  });

  test("custom contextPrefix is used", async () => {
    const executor = makeExecutor([{}, {}]);
    const result = await runPipeline(
      {
        stages: [
          { prompt: "first" },
          { prompt: "second", contextPrefix: "CONTEXT:\n" },
        ],
      },
      executor,
    );

    expect(result.success).toBe(true);
    expect(executor.prompts[1]).toContain("CONTEXT:\nresult-1");
    expect(executor.prompts[1]).not.toContain("Previous stage result");
  });
});
