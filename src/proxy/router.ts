/**
 * Proxy router — picks which registered LLMProvider handles an inbound
 * proxy request, given the `model` name in the request body.
 *
 * Resolution order:
 *   1. Exact provider-name match (e.g. model="claude" and a provider named
 *      "claude" is registered)
 *   2. Prefix heuristics: "claude-*" → any anthropic / claude-cli provider,
 *      "gemini-*" → gemini-* providers, "gpt-*"|"o1-*"|"o3-*" → openai /
 *      codex-backend / codex-cli providers
 *   3. Fall back to the registry's default provider
 */

import type { LLMProvider, ProviderRegistry } from "../providers/types.js";

export interface ProviderPickResult {
  provider: LLMProvider;
  matchedBy: "exact-name" | "model-prefix" | "default";
}

export function pickProvider(
  registry: ProviderRegistry,
  modelName: string | undefined,
): ProviderPickResult {
  const available = registry.listProviders();

  if (modelName) {
    // 1. exact provider-name match
    if (available.includes(modelName)) {
      return {
        provider: registry.getProvider(modelName),
        matchedBy: "exact-name",
      };
    }

    // 2. prefix heuristic
    const family = classifyModel(modelName);
    if (family) {
      for (const name of available) {
        const p = registry.getProvider(name);
        if (matchesFamily(p, family)) {
          return { provider: p, matchedBy: "model-prefix" };
        }
      }
    }
  }

  // 3. default
  return { provider: registry.getDefault(), matchedBy: "default" };
}

type ModelFamily = "claude" | "gemini" | "openai" | "unknown";

function classifyModel(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m.includes("anthropic")) return "claude";
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) {
    return "openai";
  }
  return "unknown";
}

function matchesFamily(provider: LLMProvider, family: ModelFamily): boolean {
  switch (family) {
    case "claude":
      return provider.type === "anthropic" || provider.type === "claude-cli";
    case "gemini":
      return (
        provider.type === "gemini" ||
        provider.type === "gemini-code-assist" ||
        provider.type === "gemini-cli"
      );
    case "openai":
      return (
        provider.type === "openai" ||
        provider.type === "openai-compatible" ||
        provider.type === "codex-backend" ||
        provider.type === "codex-cli"
      );
    case "unknown":
      return false;
  }
}
