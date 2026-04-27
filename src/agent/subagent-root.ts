import type { Tool } from "../tools/types.js";
import type { LLMProvider, ProviderRegistry } from "../providers/types.js";
import { DefaultSubAgentRuntime } from "./subagent-runtime.js";

export function createRootSubAgentRuntime(
  provider: LLMProvider,
  tools: Tool[],
  providerRegistry?: ProviderRegistry,
) {
  return new DefaultSubAgentRuntime({
    provider,
    tools,
    providerResolver: providerRegistry
      ? ({ request, parentProvider }) =>
          providerRegistry.instantiateProviderForChild(parentProvider.name, {
            provider: request.provider,
            model: request.model,
          })
      : undefined,
  });
}
