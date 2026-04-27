import { describe, expect, test } from "bun:test";
import { pickProvider } from "../src/proxy/router.js";
import { ProviderRegistryImpl } from "../src/providers/registry.js";
import type { ProviderConfig } from "../src/providers/types.js";

const configs: ProviderConfig[] = [
  {
    name: "exact-provider",
    type: "openai-compatible",
    model: "exact-model",
    baseUrl: "http://localhost:11434/v1",
  },
  {
    name: "anthropic-backend",
    type: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "sk-test",
  },
  {
    name: "fallback-provider",
    type: "gemini",
    model: "gemini-2.5-flash",
    apiKey: "gemini-test",
  },
];

describe("proxy router", () => {
  test("prefers exact provider name matches", () => {
    const registry = new ProviderRegistryImpl(configs, "fallback-provider");
    const picked = pickProvider(registry, "exact-provider");
    expect(picked.provider.name).toBe("exact-provider");
    expect(picked.matchedBy).toBe("exact-name");
  });

  test("prefers prefix matches for claude models", () => {
    const registry = new ProviderRegistryImpl(configs, "fallback-provider");
    const picked = pickProvider(registry, "claude-3-7-sonnet");
    expect(picked.provider.name).toBe("anthropic-backend");
    expect(picked.matchedBy).toBe("model-prefix");
  });

  test("prefers prefix matches for gpt models", () => {
    const registry = new ProviderRegistryImpl(configs, "fallback-provider");
    const picked = pickProvider(registry, "gpt-4o-mini");
    expect(picked.provider.name).toBe("exact-provider");
    expect(picked.matchedBy).toBe("model-prefix");
  });

  test("falls back to the default provider for unknown models", () => {
    const registry = new ProviderRegistryImpl(configs, "fallback-provider");
    const picked = pickProvider(registry, "my-custom-model");
    expect(picked.provider.name).toBe("fallback-provider");
    expect(picked.matchedBy).toBe("default");
  });
});
