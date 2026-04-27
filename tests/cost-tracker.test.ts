import { describe, expect, test } from "bun:test";
import {
  CostTracker,
  calculateUsageCost,
  formatCost,
  formatCostStatus,
  resolveModelPricing,
  resolveModelPricingInfo,
} from "../src/agent/cost-tracker.js";
import { createAppState } from "../src/agent/context.js";
import { agentLoop } from "../src/agent/loop.js";
import type { AgentEvent } from "../src/agent/types.js";
import type { LLMProvider } from "../src/providers/types.js";

describe("CostTracker", () => {
  test("addUsage -> getCost calculates known model cost", () => {
    const tracker = new CostTracker();

    tracker.addUsage("claude-3-5-sonnet-20241022", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    const snapshot = tracker.getCost();
    expect(snapshot.inputTokens).toBe(1_000_000);
    expect(snapshot.outputTokens).toBe(1_000_000);
    expect(snapshot.totalTokens).toBe(2_000_000);
    expect(snapshot.inputCost).toBe(3);
    expect(snapshot.outputCost).toBe(15);
    expect(snapshot.totalCost).toBe(18);
    expect(snapshot.overBudget).toBe(false);
  });

  test("isOverBudget respects configured budget", () => {
    const tracker = new CostTracker();
    tracker.setBudget(0.01);

    tracker.addUsage("gpt-4o", {
      inputTokens: 2_000,
      outputTokens: 1_000,
    });

    expect(tracker.getCost().totalCost).toBe(0.015);
    expect(tracker.isOverBudget()).toBe(true);
  });

  test("unknown model has zero cost while retaining token totals", () => {
    const tracker = new CostTracker();

    tracker.addUsage("local-unknown-model", {
      inputTokens: 123,
      outputTokens: 456,
    });

    const snapshot = tracker.getCost();
    expect(snapshot.totalTokens).toBe(579);
    expect(snapshot.totalCost).toBe(0);
    expect(snapshot.hasUnknownPricing).toBe(true);
    expect(snapshot.unknownModels).toEqual(["local-unknown-model"]);
    expect(snapshot.models["local-unknown-model"]?.pricingKnown).toBe(false);
    expect(snapshot.models["local-unknown-model"]?.pricingSource).toBe("unknown");
    expect(resolveModelPricing("local-unknown-model")).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
    expect(resolveModelPricingInfo("local-unknown-model")).toMatchObject({
      known: false,
      source: "unknown",
    });
  });

  test("blank model is surfaced as an explicit unknown model", () => {
    const tracker = new CostTracker();

    tracker.addUsage("", { inputTokens: 1, outputTokens: 2 }, { provider: "mock" });

    const snapshot = tracker.getCost();
    expect(snapshot.models["(unknown model)"]?.provider).toBe("mock");
    expect(snapshot.hasUnknownPricing).toBe(true);
    expect(formatCostStatus(snapshot)).toContain("est?");
  });

  test("mixed models are accumulated", () => {
    const tracker = new CostTracker();

    tracker.addUsage("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 });
    tracker.addUsage("gemini-1.5-pro", { inputTokens: 0, outputTokens: 1_000_000 });

    const snapshot = tracker.getCost();
    expect(snapshot.inputTokens).toBe(1_000_000);
    expect(snapshot.outputTokens).toBe(1_000_000);
    expect(snapshot.totalCost).toBe(7.5);
    expect(Object.keys(snapshot.models).sort()).toEqual(["gemini-1.5-pro", "gpt-4o"]);
  });

  test("custom pricing override is supported", () => {
    const tracker = new CostTracker({
      "my-model": { inputPerMillion: 1, outputPerMillion: 2 },
    });

    tracker.addUsage("my-model-v1", { inputTokens: 500_000, outputTokens: 250_000 });

    const snapshot = tracker.getCost();
    expect(snapshot.inputCost).toBe(0.5);
    expect(snapshot.outputCost).toBe(0.5);
    expect(snapshot.totalCost).toBe(1);
  });

  test("supports snake_case usage fields", () => {
    const cost = calculateUsageCost("gpt-4o", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });

    expect(cost.totalCost).toBe(12.5);
  });

  test("formatCost keeps tiny non-zero costs visible", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(1.234)).toBe("$1.23");
  });

  test("formatCostStatus includes budget and over-budget state compactly", () => {
    expect(formatCostStatus({
      totalCost: 1.5,
      budget: 1,
      overBudget: true,
      hasUnknownPricing: false,
    })).toBe("$1.50/$1.00 over");
  });
});

describe("CostTracker agent-loop integration", () => {
  test("emits a budget warning and can stop when configured", async () => {
    const provider: LLMProvider = {
      name: "mock",
      type: "openai-compatible",
      model: "gpt-4o",
      maxContextTokens: 8192,
      supportsToolCalling: true,
      supportsPlanning: false,
      supportsStreaming: true,
      async *send() {
        yield { type: "text_delta", text: "expensive response" };
        yield {
          type: "done",
          usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
          stopReason: "end_turn",
        };
      },
    };
    const costTracker = new CostTracker();
    costTracker.setBudget(0.01);
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: [],
      costTracker,
      stopOnBudgetExceeded: true,
    });

    const events: AgentEvent[] = [];
    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "system",
    });
    let next = await loop.next();
    while (!next.done) {
      events.push(next.value);
      next = await loop.next();
    }

    expect(events.some((event) => event.type === "warning" && event.code === "budget_exceeded")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
    expect(next.value.reason).toBe("aborted");
  });
});
