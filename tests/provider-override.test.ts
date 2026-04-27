import { describe, expect, test } from "bun:test";
import {
  instantiateProvider,
  instantiateProviderForChild,
  instantiateProviderForChildOrFallback,
  resolveProviderConfigForChild,
  resolveProviderConfigForChildOrFallback,
  ProviderOverrideError,
  ProviderRegistryImpl,
} from "../src/providers/registry.js";
import { providerOverrideSchema } from "../src/config/schema.js";

describe("provider override helpers", () => {
  const configs = [
    {
      name: "base",
      type: "openai-compatible" as const,
      model: "base-model",
      baseUrl: "http://localhost:11434/v1",
    },
    {
      name: "alt",
      type: "openai-compatible" as const,
      model: "alt-model",
      baseUrl: "http://localhost:11434/v1",
    },
  ];

  test("providerOverrideSchema validates provider/model overrides", () => {
    expect(providerOverrideSchema.parse({ provider: "alt", model: "child-model" })).toEqual({
      provider: "alt",
      model: "child-model",
    });
    expect(() => providerOverrideSchema.parse({ provider: "" })).toThrow();
  });

  test("resolveProviderConfigForChild applies model override", () => {
    const registry = new ProviderRegistryImpl(configs, "base");
    const resolved = resolveProviderConfigForChild(registry, "base", { model: "child-model" });

    expect(resolved.name).toBe("base");
    expect(resolved.model).toBe("child-model");
    expect(resolved.type).toBe("openai-compatible");
  });

  test("resolveProviderConfigForChild switches provider and preserves override model", () => {
    const registry = new ProviderRegistryImpl(configs, "base");
    const resolved = resolveProviderConfigForChild(registry, "base", {
      provider: "alt",
      model: "child-model",
    });

    expect(resolved.name).toBe("alt");
    expect(resolved.model).toBe("child-model");
    expect(resolved.type).toBe("openai-compatible");
  });

  test("resolveProviderConfigForChild throws clear error for unknown provider", () => {
    const registry = new ProviderRegistryImpl(configs, "base");

    expect(() =>
      resolveProviderConfigForChild(registry, "base", {
        provider: "missing",
        model: "child-model",
      }),
    ).toThrow(ProviderOverrideError);
    expect(() =>
      resolveProviderConfigForChild(registry, "base", {
        provider: "missing",
        model: "child-model",
      }),
    ).toThrow('Unable to resolve child provider "missing"');
  });

  test("fallback helper uses base provider when override provider is missing", () => {
    const registry = new ProviderRegistryImpl(configs, "base");
    const resolved = resolveProviderConfigForChildOrFallback(registry, "base", {
      provider: "missing",
      model: "child-model",
    });

    expect(resolved.name).toBe("base");
    expect(resolved.model).toBe("child-model");
  });

  test("instantiateProviderForChild returns the selected provider", () => {
    const registry = new ProviderRegistryImpl(configs, "base");
    const provider = instantiateProviderForChild(registry, "base", {
      provider: "alt",
      model: "child-model",
    });

    expect(provider.name).toBe("alt");
    expect(provider.model).toBe("child-model");
  });

  test("instantiateProviderForChildOrFallback falls back safely", () => {
    const registry = new ProviderRegistryImpl(configs, "base");
    const provider = instantiateProviderForChildOrFallback(registry, "base", {
      provider: "missing",
      model: "child-model",
    });

    expect(provider.name).toBe("base");
    expect(provider.model).toBe("child-model");
  });

  test("existing instantiateProvider path is unchanged", () => {
    const provider = instantiateProvider({
      ...configs[0]!,
      model: "override-model",
    });

    expect(provider.name).toBe("base");
    expect(provider.model).toBe("override-model");
  });
});
