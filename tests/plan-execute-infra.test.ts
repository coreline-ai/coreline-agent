import { describe, expect, test } from "bun:test";
import { instantiateProvider } from "../src/providers/registry.js";
import { StubPlanner } from "../src/agent/plan-execute/stub-planner.js";
import { createAppState } from "../src/agent/context.js";
import type { Task } from "../src/agent/plan-execute/types.js";

describe("plan-execute infra", () => {
  test("Anthropic provider reports supportsPlanning=true", () => {
    const provider = instantiateProvider({
      name: "claude",
      type: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-test",
    });

    expect(provider.supportsPlanning).toBe(true);
  });

  test("OpenAI provider reports supportsPlanning=true", () => {
    const provider = instantiateProvider({
      name: "openai",
      type: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    expect(provider.supportsPlanning).toBe(true);
  });

  test("OpenAI-compatible provider defaults supportsPlanning=false", () => {
    const provider = instantiateProvider({
      name: "local",
      type: "openai-compatible",
      model: "qwen2.5-coder:7b",
      baseUrl: "http://localhost:11434/v1",
    });

    expect(provider.supportsPlanning).toBe(false);
  });

  test("OpenAI-compatible provider enables supportsPlanning when config says so", () => {
    const provider = instantiateProvider({
      name: "local",
      type: "openai-compatible",
      model: "qwen2.5-coder:7b",
      baseUrl: "http://localhost:11434/v1",
      planning: true,
    });

    expect(provider.supportsPlanning).toBe(true);
  });

  test("StubPlanner produces a heuristic plan", async () => {
    const provider = instantiateProvider({
      name: "local",
      type: "openai-compatible",
      model: "qwen2.5-coder:7b",
      baseUrl: "http://localhost:11434/v1",
    });
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
    });

    const plan = await new StubPlanner().plan("review src and run tests", state);

    expect(plan.goal).toBe("review src and run tests");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.status).toBe("pending");
    expect(plan.tasks[0]?.dependsOn).toEqual([]);
    expect(plan.tasks[1]?.dependsOn).toEqual(["task-1"]);
  });

  test("Task type supports the expected status values", () => {
    const pendingTask = {
      id: "task-1",
      description: "Inspect source files",
      dependsOn: [],
      status: "pending",
    } satisfies Task;
    const runningTask = { ...pendingTask, status: "running" } satisfies Task;
    const completedTask = { ...pendingTask, status: "completed", result: { ok: true } } satisfies Task;

    expect(pendingTask.status).toBe("pending");
    expect(runningTask.status).toBe("running");
    expect(completedTask.status).toBe("completed");
  });
});
