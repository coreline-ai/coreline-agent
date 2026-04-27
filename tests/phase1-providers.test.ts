/**
 * Phase 1 smoke tests — provider registry + config schema.
 */

import { describe, test, expect } from "bun:test";
import {
  instantiateProvider,
  ProviderRegistryImpl,
} from "../src/providers/registry.js";
import { parseProvidersFile } from "../src/config/schema.js";
import type { ProviderConfig } from "../src/providers/types.js";

describe("ProviderRegistry", () => {
  const configs: ProviderConfig[] = [
    { name: "test-oai", type: "openai-compatible", model: "test", baseUrl: "http://localhost:11434/v1" },
    { name: "test-claude", type: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-test" },
  ];

  test("listProviders returns registered names", () => {
    const registry = new ProviderRegistryImpl(configs, "test-oai");
    expect(registry.listProviders()).toEqual(["test-oai", "test-claude"]);
  });

  test("getProvider returns correct provider", () => {
    const registry = new ProviderRegistryImpl(configs, "test-oai");
    const provider = registry.getProvider("test-oai");
    expect(provider.name).toBe("test-oai");
    expect(provider.type).toBe("openai-compatible");
  });

  test("getDefault returns default provider", () => {
    const registry = new ProviderRegistryImpl(configs, "test-claude");
    expect(registry.getDefault().name).toBe("test-claude");
  });

  test("setDefault changes default", () => {
    const registry = new ProviderRegistryImpl(configs, "test-oai");
    registry.setDefault("test-claude");
    expect(registry.getDefault().name).toBe("test-claude");
  });

  test("getProvider throws for unknown name", () => {
    const registry = new ProviderRegistryImpl(configs);
    expect(() => registry.getProvider("nonexistent")).toThrow("not found");
  });

  test("instantiateProvider respects model override in config", () => {
    const provider = instantiateProvider({
      ...configs[0]!,
      model: "override-model",
    });
    expect(provider.model).toBe("override-model");
  });

  test("instantiateProviderForChild supports provider/model overrides", () => {
    const registry = new ProviderRegistryImpl(configs, "test-oai");
    const provider = registry.instantiateProviderForChild("test-oai", {
      provider: "test-claude",
      model: "override-child-model",
    });

    expect(provider.name).toBe("test-claude");
    expect(provider.model).toBe("override-child-model");
  });
});

describe("Config Schema", () => {
  test("parseProvidersFile parses valid config", () => {
    const data = {
      default: "claude",
      providers: {
        claude: { type: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-test" },
        local: { type: "openai-compatible", model: "llama3.1", baseUrl: "http://localhost:11434/v1" },
      },
    };

    const result = parseProvidersFile(data);
    expect(result.configs).toHaveLength(2);
    expect(result.defaultName).toBe("claude");
    expect(result.configs[0]!.name).toBe("claude");
    expect(result.configs[1]!.name).toBe("local");
  });

  test("parseProvidersFile throws for invalid config", () => {
    expect(() => parseProvidersFile({ providers: {} })).not.toThrow();
    expect(() => parseProvidersFile({ providers: { x: {} } })).toThrow();
  });
});
