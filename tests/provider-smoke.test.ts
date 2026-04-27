import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { LLMProvider, ProviderConfig } from "../src/providers/types.js";

const SHOULD_RUN = process.env.CORELINE_RUN_PROVIDER_SMOKE === "1";
const RAW_TARGETS = process.env.CORELINE_PROVIDER_SMOKE_TARGETS?.split(",")
  .map((target) => target.trim().toLowerCase())
  .filter(Boolean);
const TARGETS = RAW_TARGETS && RAW_TARGETS.length > 0 ? new Set(RAW_TARGETS) : null;

function shouldRunTarget(target: string): boolean {
  return TARGETS === null || TARGETS.has(target.toLowerCase());
}

async function collectText(provider: LLMProvider): Promise<string> {
  let text = "";
  for await (const chunk of provider.send({
    messages: [{ role: "user", content: "Reply with OK" }],
    systemPrompt: "You are a smoke test. Reply with OK only.",
  })) {
    if (chunk.type === "text_delta") {
      text += chunk.text;
    }
  }
  return text;
}

async function runSmoke(config: ProviderConfig): Promise<string> {
  const provider =
    config.type === "anthropic"
      ? new AnthropicProvider(config)
      : config.type === "openai"
        ? new OpenAIProvider(config)
        : config.type === "gemini"
          ? new GeminiProvider(config)
          : new OpenAICompatibleProvider(config);

  return collectText(provider);
}

describe("Provider smoke tests", () => {
  test("smoke tests are opt-in", () => {
    if (!SHOULD_RUN) {
      expect(true).toBe(true);
    }
  });

  test("Anthropic smoke", async () => {
    if (!SHOULD_RUN || !shouldRunTarget("anthropic") || !process.env.ANTHROPIC_API_KEY) return;
    const text = await runSmoke({
      name: "claude-smoke",
      type: "anthropic",
      model: process.env.CORELINE_ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    expect(text.toUpperCase()).toContain("OK");
  }, 30_000);

  test("OpenAI smoke", async () => {
    if (!SHOULD_RUN || !shouldRunTarget("openai") || !process.env.OPENAI_API_KEY) return;
    const text = await runSmoke({
      name: "openai-smoke",
      type: "openai",
      model: process.env.CORELINE_OPENAI_MODEL ?? "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY,
    });
    expect(text.toUpperCase()).toContain("OK");
  }, 30_000);

  test("Gemini smoke", async () => {
    if (!SHOULD_RUN || !shouldRunTarget("gemini") || !process.env.GOOGLE_API_KEY) return;
    const text = await runSmoke({
      name: "gemini-smoke",
      type: "gemini",
      model: process.env.CORELINE_GEMINI_MODEL ?? "gemini-2.5-flash",
      apiKey: process.env.GOOGLE_API_KEY,
    });
    expect(text.toUpperCase()).toContain("OK");
  }, 30_000);

  test("OpenAI-compatible smoke", async () => {
    if (!SHOULD_RUN || !shouldRunTarget("compatible") || !process.env.CORELINE_OAI_BASE_URL || !process.env.CORELINE_OAI_MODEL) return;
    const text = await runSmoke({
      name: "compatible-smoke",
      type: "openai-compatible",
      model: process.env.CORELINE_OAI_MODEL,
      baseUrl: process.env.CORELINE_OAI_BASE_URL,
      apiKey: process.env.CORELINE_OAI_API_KEY,
    });
    expect(text.toUpperCase()).toContain("OK");
  }, 30_000);
});
