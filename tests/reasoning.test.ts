/**
 * Reasoning feature tests — think tag parser + reasoning events.
 */

import { describe, test, expect } from "bun:test";
import { ThinkTagParser } from "../src/providers/think-tag-parser.js";

describe("ThinkTagParser", () => {
  test("plain text without think tags emits text only", () => {
    const p = new ThinkTagParser();
    const emits = [...p.feed("Hello world"), ...p.flush()];
    expect(emits).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("think tag content is emitted as reasoning", () => {
    const p = new ThinkTagParser();
    const emits = [...p.feed("<think>planning</think>"), ...p.flush()];
    expect(emits).toEqual([{ type: "reasoning", text: "planning" }]);
  });

  test("<thinking> alias works", () => {
    const p = new ThinkTagParser();
    const emits = [...p.feed("<thinking>reasoning here</thinking>"), ...p.flush()];
    expect(emits).toEqual([{ type: "reasoning", text: "reasoning here" }]);
  });

  test("mixed text + think produces both emits in order", () => {
    const p = new ThinkTagParser();
    const emits = [...p.feed("Before <think>plan</think> After"), ...p.flush()];
    expect(emits).toEqual([
      { type: "text", text: "Before " },
      { type: "reasoning", text: "plan" },
      { type: "text", text: " After" },
    ]);
  });

  test("split chunks handle tag spanning chunk boundary", () => {
    const p = new ThinkTagParser();
    const emits = [
      ...p.feed("Hello <thi"),
      ...p.feed("nk>reason"),
      ...p.feed("ing</thi"),
      ...p.feed("nk> done"),
      ...p.flush(),
    ];
    // Concat all text and reasoning by type
    const texts = emits.filter((e) => e.type === "text").map((e) => e.text).join("");
    const reasons = emits.filter((e) => e.type === "reasoning").map((e) => e.text).join("");
    expect(texts.trim()).toBe("Hello  done".trim());
    expect(reasons).toBe("reasoning");
  });

  test("incomplete think tag at end is emitted as text on flush", () => {
    const p = new ThinkTagParser();
    const emits = [...p.feed("Hello <thi"), ...p.flush()];
    const texts = emits.filter((e) => e.type === "text").map((e) => e.text).join("");
    expect(texts).toBe("Hello <thi");
  });

  test("multiple think blocks", () => {
    const p = new ThinkTagParser();
    const emits = [
      ...p.feed("<think>first</think>middle<think>second</think>end"),
      ...p.flush(),
    ];
    const reasons = emits.filter((e) => e.type === "reasoning").map((e) => e.text);
    const texts = emits.filter((e) => e.type === "text").map((e) => e.text);
    expect(reasons).toEqual(["first", "second"]);
    expect(texts).toEqual(["middle", "end"]);
  });

  test("empty chunks are safe", () => {
    const p = new ThinkTagParser();
    expect(p.feed("")).toEqual([]);
    expect(p.flush()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: reasoning events flow through agent loop
// ---------------------------------------------------------------------------

import { agentLoop } from "../src/agent/loop.js";
import { createAppState } from "../src/agent/context.js";
import type { AgentEvent } from "../src/agent/types.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";

function mockProvider(chunks: ChatChunk[]): LLMProvider {
  return {
    name: "mock", type: "openai-compatible", model: "mock", maxContextTokens: 100_000,
    supportsToolCalling: true, supportsPlanning: false, supportsStreaming: true,
    async *send(_: ChatRequest): AsyncIterable<ChatChunk> {
      for (const c of chunks) yield c;
    },
  };
}

describe("Agent loop reasoning integration", () => {
  test("forwards reasoning_delta to consumer", async () => {
    const provider = mockProvider([
      { type: "reasoning_delta", text: "thinking about it" },
      { type: "text_delta", text: "The answer is 42" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "end_turn" },
    ]);

    const state = createAppState({ cwd: process.cwd(), provider, tools: [] });
    const events: AgentEvent[] = [];
    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "test",
    });

    let r = await loop.next();
    while (!r.done) {
      events.push(r.value);
      r = await loop.next();
    }

    const reasoning = events.filter((e) => e.type === "reasoning_delta");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0] as { text: string }).text).toBe("thinking about it");
  });

  test("text and reasoning events are separate", async () => {
    const provider = mockProvider([
      { type: "text_delta", text: "Hi " },
      { type: "reasoning_delta", text: "user is greeting" },
      { type: "text_delta", text: "there!" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "end_turn" },
    ]);

    const state = createAppState({ cwd: process.cwd(), provider, tools: [] });
    const events: AgentEvent[] = [];
    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "test",
    });

    let r = await loop.next();
    while (!r.done) {
      events.push(r.value);
      r = await loop.next();
    }

    const texts = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    const reasoning = events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join("");

    expect(texts).toBe("Hi there!");
    expect(reasoning).toBe("user is greeting");
  });
});
