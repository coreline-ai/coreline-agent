/**
 * 5-dimensional critique framework — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Tests cover heuristic fallback, env-gating, LLM success path, malformed
 * JSON, missing API key, average computation, timeout, and color heuristic.
 *
 * Mock pattern matches tests/rca-llm-strategy.test.ts (F6): we patch
 * Anthropic.Messages.prototype.create so no real network calls happen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { computeCritique } from "../src/agent/critique/engine.js";
import { computeHeuristicCritique } from "../src/agent/critique/heuristic-fallback.js";
import {
  CRITIQUE_DIMENSIONS,
  type CritiqueDimension,
} from "../src/agent/critique/types.js";

type MessagesCreate = (
  ...args: unknown[]
) => Promise<{ content: Array<{ type: string; text: string }> }>;

const messagesProto = (
  Anthropic as unknown as {
    Messages: { prototype: { create: MessagesCreate } };
  }
).Messages.prototype;
const originalCreate: MessagesCreate = messagesProto.create;

function setMessagesCreate(fn: MessagesCreate): void {
  messagesProto.create = fn;
}

const SAVED_ENV: { enabled?: string; apiKey?: string } = {};

beforeEach(() => {
  SAVED_ENV.enabled = process.env.CRITIQUE_LLM_ENABLED;
  SAVED_ENV.apiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.CRITIQUE_LLM_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  messagesProto.create = originalCreate;
});

afterEach(() => {
  if (SAVED_ENV.enabled !== undefined)
    process.env.CRITIQUE_LLM_ENABLED = SAVED_ENV.enabled;
  else delete process.env.CRITIQUE_LLM_ENABLED;
  if (SAVED_ENV.apiKey !== undefined)
    process.env.ANTHROPIC_API_KEY = SAVED_ENV.apiKey;
  else delete process.env.ANTHROPIC_API_KEY;
  messagesProto.create = originalCreate;
});

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { color: #333333; background: #ffffff; font-family: Inter, sans-serif; }
    h1 { color: #000000; }
    .accent { color: #ff5500; }
  </style>
</head>
<body>
  <h1>Hello</h1>
  <h2>Section</h2>
  <h3>Sub</h3>
  <p>Body</p>
  <img src="logo.svg" />
</body>
</html>`;

function buildLLMResponseJSON(): string {
  return JSON.stringify({
    scores: [
      { dimension: "philosophy", score: 8, reasoning: "Clear minimalist intent." },
      { dimension: "visual-hierarchy", score: 7, reasoning: "Strong contrast." },
      { dimension: "craft", score: 7, reasoning: "Two spacing inconsistencies." },
      { dimension: "functionality", score: 7, reasoning: "One filler element." },
      { dimension: "originality", score: 6, reasoning: "Pattern feels familiar." },
    ],
    keep: ["Excellent whitespace usage", "Strong typography hierarchy"],
    fix: [
      {
        severity: "warning",
        issue: "border-left card pattern",
        suggestion: "Use color contrast or weight instead",
      },
    ],
    quickWins: [
      "Reduce color palette (5 to 3)",
      "Increase button padding to 44x44px",
      "Add focus visible styles",
    ],
  });
}

describe("critique engine — Phase 2 / R4", () => {
  test("R4-1: heuristic fallback returns 5 scores + result shape", () => {
    const result = computeHeuristicCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
    });
    expect(result.strategy).toBe("heuristic");
    expect(result.scores).toHaveLength(5);
    const dims = result.scores.map((s) => s.dimension);
    for (const dim of CRITIQUE_DIMENSIONS) {
      expect(dims).toContain(dim as CritiqueDimension);
    }
    expect(result.keep.length).toBeGreaterThan(0);
    expect(result.quickWins.length).toBeLessThanOrEqual(3);
    expect(result.targetPath).toBe("design.html");
  });

  test("R4-2: CRITIQUE_LLM_ENABLED=false forces heuristic", async () => {
    process.env.CRITIQUE_LLM_ENABLED = "false";
    process.env.ANTHROPIC_API_KEY = "test-key";
    let llmCalled = false;
    setMessagesCreate(async () => {
      llmCalled = true;
      return { content: [{ type: "text", text: buildLLMResponseJSON() }] };
    });
    const result = await computeCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
    });
    expect(llmCalled).toBe(false);
    expect(result.strategy).toBe("heuristic");
  });

  test("R4-3: LLM mock returns LLM-strategy result with mapped scores", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({
      content: [{ type: "text", text: buildLLMResponseJSON() }],
    }));
    const result = await computeCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
    });
    expect(result.strategy).toBe("llm");
    expect(result.scores).toHaveLength(5);
    const philosophy = result.scores.find((s) => s.dimension === "philosophy");
    expect(philosophy?.score).toBe(8);
    expect(result.keep).toContain("Excellent whitespace usage");
    expect(result.fix[0]?.severity).toBe("warning");
    expect(result.quickWins).toHaveLength(3);
  });

  test("R4-4: malformed JSON falls back to heuristic", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({
      content: [{ type: "text", text: "this is definitely not json" }],
    }));
    const result = await computeCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
    });
    expect(result.strategy).toBe("heuristic");
    expect(result.scores).toHaveLength(5);
  });

  test("R4-5: missing ANTHROPIC_API_KEY falls back to heuristic", async () => {
    // No API key in env; default strategy = llm; should silently fall back.
    const result = await computeCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
    });
    expect(result.strategy).toBe("heuristic");
  });

  test("R4-6: overall score equals average of 5 dimension scores", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({
      content: [{ type: "text", text: buildLLMResponseJSON() }],
    }));
    const result = await computeCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
    });
    const sum = result.scores.reduce((acc, s) => acc + s.score, 0);
    const expected = Math.round((sum / result.scores.length) * 10) / 10;
    expect(result.overallScore).toBeCloseTo(expected, 4);
    // Sanity: 8+7+7+7+6 = 35 / 5 = 7.0
    expect(result.overallScore).toBeCloseTo(7.0, 4);
  });

  test("R4-7: timeout triggers heuristic fallback", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                content: [{ type: "text", text: buildLLMResponseJSON() }],
              }),
            500,
          ),
        ),
    );
    const result = await computeCritique({
      targetPath: "design.html",
      content: SAMPLE_HTML,
      options: { timeoutMs: 25 },
    });
    expect(result.strategy).toBe("heuristic");
  });

  test("R4-8: heuristic — disciplined palette (<=4 colors, <=2 fonts) yields craft >= 7", () => {
    const tightContent = `<!DOCTYPE html>
<html><head><style>
body { color: #111; background: #fff; font-family: Inter; }
.muted { color: #666; }
</style></head>
<body><h1>A</h1><h2>B</h2></body></html>`;
    const result = computeHeuristicCritique({
      targetPath: "tight.html",
      content: tightContent,
    });
    const craft = result.scores.find((s) => s.dimension === "craft");
    expect(craft).toBeDefined();
    expect(craft!.score).toBeGreaterThanOrEqual(7);
  });
});
