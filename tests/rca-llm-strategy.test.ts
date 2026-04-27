/**
 * Wave 10 P2 / F6 — RCA LLM strategy unit tests.
 *
 * Covers env-gating, missing API key, success path, malformed JSON, and
 * timeout. The Anthropic SDK is monkey-patched on the prototype so tests
 * never make real network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { scoreHypothesesViaLLM } from "../src/agent/rca/llm-strategy.js";
import type { IncidentRecord } from "../src/agent/incident/types.js";

type MessagesCreate = (
  ...args: unknown[]
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// Patch Anthropic.Messages.prototype.create — every Anthropic instance
// receives a fresh `new Messages(this)` whose `create` is inherited via
// the prototype, so this intercepts SDK calls without instance access.
const messagesProto = (
  Anthropic as unknown as { Messages: { prototype: { create: MessagesCreate } } }
).Messages.prototype;
const originalCreate: MessagesCreate = messagesProto.create;

function setMessagesCreate(fn: MessagesCreate): void {
  messagesProto.create = fn;
}

function makeIncident(): IncidentRecord {
  return {
    id: "inc-19700101-000000-deadbeef",
    title: "API outage",
    severity: "high",
    status: "open",
    detectedAt: "2025-01-01T00:00:00Z",
    validFrom: "2025-01-01T00:00:00Z",
    recordedAt: "2025-01-01T00:00:00Z",
    tier: "core",
    source: "manual",
    affected: ["api"],
    tags: [],
    symptoms: ["503 spike on /v1/users"],
    evidence: [{ type: "log", value: "ENOSPC", collectedAt: "" }],
    hypotheses: [
      { text: "upstream timeout", status: "testing", notedAt: "" },
      { text: "disk full", status: "rejected", notedAt: "" },
    ],
    related: [],
  };
}

const SAVED_ENV: { enabled?: string; apiKey?: string } = {};

beforeEach(() => {
  SAVED_ENV.enabled = process.env.RCA_LLM_ENABLED;
  SAVED_ENV.apiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.RCA_LLM_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  // Restore original create before each test.
  messagesProto.create = originalCreate;
});

afterEach(() => {
  if (SAVED_ENV.enabled !== undefined)
    process.env.RCA_LLM_ENABLED = SAVED_ENV.enabled;
  else delete process.env.RCA_LLM_ENABLED;
  if (SAVED_ENV.apiKey !== undefined)
    process.env.ANTHROPIC_API_KEY = SAVED_ENV.apiKey;
  else delete process.env.ANTHROPIC_API_KEY;
  messagesProto.create = originalCreate;
});

describe("RCA LLM strategy — Wave 10 P2 / F6", () => {
  test("F6-1: RCA_LLM_ENABLED unset → fallback (used:false)", async () => {
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toMatch(/RCA_LLM_ENABLED/);
    expect(result.hypotheses).toEqual([]);
  });

  test("F6-2: RCA_LLM_ENABLED=true but ANTHROPIC_API_KEY missing → fallback", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("F6-3: explicit options.apiKey overrides missing env", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    setMessagesCreate(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            scored: [{ text: "upstream timeout", score: 0.7 }],
            new: [],
          }),
        },
      ],
    }));
    const result = await scoreHypothesesViaLLM(makeIncident(), {
      apiKey: "test-key",
    });
    expect(result.used).toBe(true);
    expect(result.hypotheses.length).toBe(1);
    expect(result.hypotheses[0]!.text).toBe("upstream timeout");
    expect(result.hypotheses[0]!.score).toBeCloseTo(0.7, 4);
    expect(result.hypotheses[0]!.status).toBe("testing");
  });

  test("F6-4: valid LLM response → scored + new hypotheses returned", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            scored: [
              { text: "upstream timeout", score: 0.85, reasoning: "503 spike" },
              { text: "disk full", score: 0.9 },
            ],
            new: [
              { text: "TLS cert expired", score: 0.6 },
              { text: "DNS failure", score: 0.4 },
            ],
          }),
        },
      ],
    }));
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(true);
    // 'disk full' was rejected on the incident → score forced to 0.05.
    const diskFull = result.hypotheses.find((h) => h.text === "disk full");
    expect(diskFull?.status).toBe("rejected");
    expect(diskFull?.score).toBe(0.05);
    // 'upstream timeout' was testing → LLM score honored.
    const timeout = result.hypotheses.find(
      (h) => h.text === "upstream timeout",
    );
    expect(timeout?.status).toBe("testing");
    expect(timeout?.score).toBeCloseTo(0.85, 4);
    // New hypotheses are capped at 2.
    expect(result.newHypotheses?.length).toBe(2);
    expect(result.newHypotheses?.[0]!.status).toBe("testing");
  });

  test("F6-5: response wrapped in ```json fence → parsed", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({
      content: [
        {
          type: "text",
          text:
            "Here is my analysis:\n```json\n" +
            JSON.stringify({
              scored: [{ text: "upstream timeout", score: 0.5 }],
            }) +
            "\n```",
        },
      ],
    }));
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(true);
    expect(result.hypotheses.length).toBe(1);
  });

  test("F6-6: malformed JSON → fallback used:false", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({
      content: [{ type: "text", text: "not actually json at all" }],
    }));
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toMatch(/not valid JSON/);
  });

  test("F6-7: SDK throws → fallback used:false with error reason", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => {
      throw new Error("network down");
    });
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toMatch(/network down/);
  });

  test("F6-8: timeout → fallback used:false", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ content: [{ type: "text", text: "{}" }] }),
            500,
          ),
        ),
    );
    const result = await scoreHypothesesViaLLM(makeIncident(), {
      timeoutMs: 25,
    });
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toMatch(/timeout/i);
  });

  test("F6-9: response missing text block → fallback", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    setMessagesCreate(async () => ({ content: [] }));
    const result = await scoreHypothesesViaLLM(makeIncident());
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toMatch(/missing text block/);
  });
});
