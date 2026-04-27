/**
 * Provider Registry — loads providers from config, manages default selection.
 */

import type {
  LLMProvider,
  ProviderConfig,
  ProviderOverride,
  ProviderRegistry as IProviderRegistry,
} from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { CodexBackendProvider } from "./codex-backend.js";
import { GeminiCodeAssistProvider } from "./gemini-code-assist.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { GeminiCliProvider } from "./gemini-cli.js";
import { CodexCliProvider } from "./codex-cli.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function instantiateProvider(config: ProviderConfig): LLMProvider {
  // Resolve env var references like ${ANTHROPIC_API_KEY}
  const resolved = { ...config };
  if (resolved.apiKey) {
    resolved.apiKey = resolveEnvVars(resolved.apiKey);
  }
  if (resolved.oauthToken) {
    resolved.oauthToken = resolveEnvVars(resolved.oauthToken);
  }
  if (resolved.oauthFile) {
    resolved.oauthFile = resolveEnvVars(resolved.oauthFile);
  }

  switch (resolved.type) {
    case "anthropic":
      return new AnthropicProvider(resolved);
    case "openai":
      return new OpenAIProvider(resolved);
    case "gemini":
      return new GeminiProvider(resolved);
    case "openai-compatible":
      return new OpenAICompatibleProvider(resolved);
    case "codex-backend":
      return new CodexBackendProvider(resolved);
    case "gemini-code-assist":
      return new GeminiCodeAssistProvider(resolved);
    case "claude-cli":
      return new ClaudeCliProvider(resolved);
    case "gemini-cli":
      return new GeminiCliProvider(resolved);
    case "codex-cli":
      return new CodexCliProvider(resolved);
    default: {
      const unknownType: string = (resolved as { type: string }).type;
      throw new Error(`Unknown provider type: ${unknownType}`);
    }
  }
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

export class ProviderOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOverrideError";
  }
}

function cloneProviderConfig(config: ProviderConfig): ProviderConfig {
  return { ...config };
}

function applyModelOverride(config: ProviderConfig, override?: ProviderOverride): ProviderConfig {
  if (!override?.model) {
    return cloneProviderConfig(config);
  }

  return {
    ...config,
    model: override.model,
  };
}

function getAvailableProviderNames(registry: Pick<IProviderRegistry, "listProviders">): string {
  return registry.listProviders().join(", ");
}

export function resolveProviderConfigForChild(
  registry: Pick<IProviderRegistry, "getProviderConfig" | "listProviders">,
  baseName: string,
  override?: ProviderOverride,
): ProviderConfig {
  const selectedName = override?.provider ?? baseName;

  try {
    const selected = registry.getProviderConfig(selectedName);
    return applyModelOverride(selected, override);
  } catch (error) {
    const available = getAvailableProviderNames(registry) || "(none)";
    const suffix =
      error instanceof Error && error.message ? ` Cause: ${error.message}` : "";
    throw new ProviderOverrideError(
      `Unable to resolve child provider "${selectedName}" from base "${baseName}". Available: ${available}.${suffix}`,
    );
  }
}

export function resolveProviderConfigForChildOrFallback(
  registry: Pick<IProviderRegistry, "getProviderConfig" | "getDefaultProviderConfig" | "listProviders">,
  baseName: string,
  override?: ProviderOverride,
): ProviderConfig {
  const selectedName = override?.provider ?? baseName;

  try {
    return resolveProviderConfigForChild(registry, baseName, override);
  } catch {
    try {
      return applyModelOverride(registry.getProviderConfig(baseName), override);
    } catch {
      try {
        return applyModelOverride(registry.getDefaultProviderConfig(), override);
      } catch (error) {
        const available = getAvailableProviderNames(registry) || "(none)";
        const suffix =
          error instanceof Error && error.message ? ` Cause: ${error.message}` : "";
        throw new ProviderOverrideError(
          `Unable to resolve child provider "${selectedName}" or fall back from base "${baseName}". Available: ${available}.${suffix}`,
        );
      }
    }
  }
}

export function instantiateProviderForChild(
  registry: Pick<IProviderRegistry, "getProviderConfig" | "listProviders">,
  baseName: string,
  override?: ProviderOverride,
): LLMProvider {
  return instantiateProvider(resolveProviderConfigForChild(registry, baseName, override));
}

export function instantiateProviderForChildOrFallback(
  registry: Pick<IProviderRegistry, "getProviderConfig" | "getDefaultProviderConfig" | "listProviders">,
  baseName: string,
  override?: ProviderOverride,
): LLMProvider {
  return instantiateProvider(resolveProviderConfigForChildOrFallback(registry, baseName, override));
}

// ---------------------------------------------------------------------------
// Registry Implementation
// ---------------------------------------------------------------------------

export class ProviderRegistryImpl implements IProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private providerConfigs = new Map<string, ProviderConfig>();
  private defaultName: string;

  constructor(configs: ProviderConfig[], defaultName?: string) {
    for (const config of configs) {
      this.providerConfigs.set(config.name, cloneProviderConfig(config));
      this.providers.set(config.name, instantiateProvider(config));
    }
    this.defaultName = defaultName ?? configs[0]?.name ?? "";
  }

  getProvider(name: string): LLMProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const available = [...this.providers.keys()].join(", ");
      throw new Error(
        `Provider "${name}" not found. Available: ${available || "(none)"}`,
      );
    }
    return provider;
  }

  getProviderConfig(name: string): ProviderConfig {
    const config = this.providerConfigs.get(name);
    if (!config) {
      const available = [...this.providerConfigs.keys()].join(", ");
      throw new Error(
        `Provider config "${name}" not found. Available: ${available || "(none)"}`,
      );
    }
    return cloneProviderConfig(config);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  getDefault(): LLMProvider {
    return this.getProvider(this.defaultName);
  }

  getDefaultProviderConfig(): ProviderConfig {
    return this.getProviderConfig(this.defaultName);
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" not found`);
    }
    this.defaultName = name;
  }

  instantiateProviderForChild(baseName: string, override?: ProviderOverride): LLMProvider {
    return instantiateProviderForChild(this, baseName, override);
  }
}
