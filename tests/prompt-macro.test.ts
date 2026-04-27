import { describe, expect, test } from "bun:test";
import type { PromptMacro } from "../src/agent/intelligence-types.js";
import type { PipelineExecutor } from "../src/agent/pipeline-runner.js";
import {
  parsePromptMacro,
  promptMacroToPipelineRequest,
  runPromptMacro,
  validatePromptMacro,
} from "../src/prompt/macro.js";

const baseMacro: PromptMacro = {
  id: "deploy-check",
  name: "Deploy check",
  description: "Verify deploy readiness",
  onStepFailure: "stop",
  steps: [
    { id: "lint", prompt: "Run lint" },
    { id: "test", prompt: "Run tests", contextPrefix: "Lint result:\n" },
  ],
};

describe("prompt macro", () => {
  test("validates and adapts macro steps to pipeline stages", () => {
    expect(validatePromptMacro(baseMacro).ok).toBe(true);
    const adapted = promptMacroToPipelineRequest(baseMacro);

    expect(adapted.request.goal).toBe("Verify deploy readiness");
    expect(adapted.request.onStageFailure).toBe("stop");
    expect(adapted.stages.map((stage) => stage.prompt)).toEqual(["Run lint", "Run tests"]);
  });

  test("maps continue failure policy to pipeline skip policy", () => {
    const adapted = promptMacroToPipelineRequest({ ...baseMacro, onStepFailure: "continue" });
    expect(adapted.request.onStageFailure).toBe("skip");
  });

  test("rejects invalid ids, max-step overflow, and cycles", () => {
    expect(validatePromptMacro({ ...baseMacro, id: "bad/id" }).ok).toBe(false);
    expect(validatePromptMacro({ ...baseMacro, steps: baseMacro.steps, maxSteps: 1 }).ok).toBe(false);

    const cyclic: PromptMacro = {
      id: "a",
      name: "A",
      steps: [{ prompt: "call b", macroRef: "b" }],
    };
    const other: PromptMacro = {
      id: "b",
      name: "B",
      steps: [{ prompt: "call a", macroRef: "a" }],
    };
    const result = validatePromptMacro(cyclic, { catalog: { a: cyclic, b: other } });
    expect(result.ok).toBe(false);
    expect(result.issues.some((item) => item.message.includes("cycle"))).toBe(true);
  });

  test("parses JSON and simple line-based macro definitions", () => {
    const fromJson = parsePromptMacro(JSON.stringify(baseMacro));
    expect(fromJson.id).toBe("deploy-check");

    const fromLines = parsePromptMacro(`# Ship check\n- Run lint\n- Run tests`);
    expect(fromLines.id).toBe("ship-check");
    expect(fromLines.steps).toHaveLength(2);
  });

  test("runs through existing pipeline runner adapter without modifying it", async () => {
    const prompts: string[] = [];
    const executor: PipelineExecutor = async (request) => {
      prompts.push(request.prompt);
      return {
        status: "completed",
        text: `done: ${request.prompt}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        provider: "mock",
      };
    };

    const result = await runPromptMacro({ macro: baseMacro }, executor);
    expect(result.success).toBe(true);
    expect(result.pipeline.completedCount).toBe(2);
    expect(prompts[1]).toContain("Lint result:");
    expect(prompts[1]).toContain("done:");
    expect(prompts[1]).toContain("Run lint");
  });
});
