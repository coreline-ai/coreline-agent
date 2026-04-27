/**
 * Wave 10 P2 / F6 — computeRCA `strategy: "llm"` integration.
 *
 * Verifies that when LLM strategy is requested but unavailable (env var off
 * or API key missing), `computeRCA` transparently falls back to the
 * heuristic and the returned report's `strategy` field is "heuristic".
 * Also exercises the success path with a monkey-patched SDK.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { incidentRecord } from "../src/agent/incident/incident-store.js";
import { computeRCA } from "../src/agent/rca/rca-engine.js";

type MessagesCreate = (
  ...args: unknown[]
) => Promise<{ content: Array<{ type: string; text: string }> }>;

const messagesProto = (
  Anthropic as unknown as { Messages: { prototype: { create: MessagesCreate } } }
).Messages.prototype;
const originalCreate: MessagesCreate = messagesProto.create;

const PROJECT_ID = "p-rca-llm-fallback";
let root: string;

const SAVED: { enabled?: string; apiKey?: string } = {};

beforeEach(() => {
  SAVED.enabled = process.env.RCA_LLM_ENABLED;
  SAVED.apiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.RCA_LLM_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  messagesProto.create = originalCreate;
  root = mkdtempSync(join(tmpdir(), "rca-llm-fallback-"));
});

afterEach(() => {
  if (SAVED.enabled !== undefined) process.env.RCA_LLM_ENABLED = SAVED.enabled;
  else delete process.env.RCA_LLM_ENABLED;
  if (SAVED.apiKey !== undefined) process.env.ANTHROPIC_API_KEY = SAVED.apiKey;
  else delete process.env.ANTHROPIC_API_KEY;
  messagesProto.create = originalCreate;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("computeRCA — LLM fallback (Wave 10 P2 / F6)", () => {
  test("F6-E1: strategy:'llm' with env off → falls back to heuristic, valid report", async () => {
    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable"],
      { hypothesis: ["upstream down"] },
      root,
    );
    const report = await computeRCA(
      PROJECT_ID,
      id,
      { strategy: "llm" },
      root,
    );
    expect(report.strategy).toBe("heuristic");
    expect(report.hypotheses.length).toBe(1);
    expect(report.hypotheses[0]!.text).toBe("upstream down");
  });

  test("F6-E2: strategy:'heuristic' (default) — unchanged behavior", async () => {
    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable"],
      { hypothesis: ["upstream down"] },
      root,
    );
    const report = await computeRCA(PROJECT_ID, id, undefined, root);
    expect(report.strategy).toBe("heuristic");
    expect(report.hypotheses.length).toBe(1);
  });

  test("F6-E3: strategy:'llm' with mocked SDK success → strategy:'llm' in report", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    messagesProto.create = async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            scored: [{ text: "upstream down", score: 0.77 }],
            new: [{ text: "load balancer misconfig", score: 0.5 }],
          }),
        },
      ],
    });

    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable"],
      { hypothesis: ["upstream down"] },
      root,
    );
    const report = await computeRCA(
      PROJECT_ID,
      id,
      { strategy: "llm" },
      root,
    );
    expect(report.strategy).toBe("llm");
    // Original hypothesis + 1 new hypothesis from LLM
    expect(report.hypotheses.length).toBe(2);
    const orig = report.hypotheses.find((h) => h.text === "upstream down");
    expect(orig?.score).toBeCloseTo(0.77, 4);
    const newHyp = report.hypotheses.find(
      (h) => h.text === "load balancer misconfig",
    );
    expect(newHyp?.status).toBe("testing");
  });

  test("F6-E4: strategy:'llm' with mocked SDK error → falls back, report still valid", async () => {
    process.env.RCA_LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    messagesProto.create = async () => {
      throw new Error("simulated API error");
    };

    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["service unavailable"],
      { hypothesis: ["upstream down"] },
      root,
    );
    const report = await computeRCA(
      PROJECT_ID,
      id,
      { strategy: "llm" },
      root,
    );
    // Fallback path → strategy reflects what actually executed.
    expect(report.strategy).toBe("heuristic");
    expect(report.hypotheses.length).toBe(1);
  });

  test("F6-E5: unknown strategy still throws", async () => {
    const id = incidentRecord(
      PROJECT_ID,
      "outage",
      ["s"],
      { hypothesis: ["h"] },
      root,
    );
    await expect(
      computeRCA(
        PROJECT_ID,
        id,
        { strategy: "bogus" as unknown as "heuristic" },
        root,
      ),
    ).rejects.toThrow(/Unknown RCA strategy/);
  });
});
