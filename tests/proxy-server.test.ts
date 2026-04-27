import { describe, expect, test } from "bun:test";
import { startProxyServer } from "../src/proxy/server.js";
import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  ProviderRegistry,
} from "../src/providers/types.js";

function toStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function createProvider(
  name: string,
  type: LLMProvider["type"],
  model: string,
  responseText: string,
): LLMProvider & { requests: ChatRequest[]; callCount: number } {
  const requests: ChatRequest[] = [];
  let callCount = 0;

  return {
    name,
    type,
    model,
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsPlanning: false,
    requests,
    get callCount() {
      return callCount;
    },
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(request);
      callCount += 1;
      yield* toStream([
        { type: "text_delta", text: responseText },
        {
          type: "done",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          stopReason: "end_turn",
        },
      ]);
    },
  };
}

function createToolRejectingProvider(
  name: string,
  type: LLMProvider["type"],
  model: string,
  responseText: string,
): LLMProvider & { requests: ChatRequest[]; callCount: number } {
  const requests: ChatRequest[] = [];
  let callCount = 0;
  return {
    name,
    type,
    model,
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsPlanning: false,
    requests,
    get callCount() {
      return callCount;
    },
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(request);
      callCount += 1;
      if (request.tools?.some((tool) => tool.kind === "hosted")) {
        throw new Error(`[${name}] hosted tool "web_search" (web_search) is not supported by this provider.`);
      }
      yield* toStream([
        { type: "text_delta", text: responseText },
        {
          type: "done",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          stopReason: "end_turn",
        },
      ]);
    },
  };
}

function createRegistry(
  providers: Array<
    LLMProvider & { requests: ChatRequest[]; callCount: number }
  >,
  defaultName: string,
): ProviderRegistry {
  const providerMap = new Map(providers.map((provider) => [provider.name, provider] as const));
  const configMap = new Map<string, ProviderConfig>(
    providers.map((provider) => [
      provider.name,
      {
        name: provider.name,
        type: provider.type,
        model: provider.model,
        baseUrl:
          provider.type === "openai-compatible" ? "http://localhost:11434/v1" : undefined,
      },
    ]),
  );

  return {
    listProviders() {
      return [...providerMap.keys()];
    },
    getProvider(name: string) {
      const provider = providerMap.get(name);
      if (!provider) {
        throw new Error(`Provider "${name}" not found`);
      }
      return provider;
    },
    getProviderConfig(name: string) {
      const config = configMap.get(name);
      if (!config) {
        throw new Error(`Provider config "${name}" not found`);
      }
      return { ...config };
    },
    getDefault() {
      const provider = providerMap.get(defaultName);
      if (!provider) {
        throw new Error(`Provider "${defaultName}" not found`);
      }
      return provider;
    },
    getDefaultProviderConfig() {
      const config = configMap.get(defaultName);
      if (!config) {
        throw new Error(`Provider config "${defaultName}" not found`);
      }
      return { ...config };
    },
    setDefault(name: string) {
      if (!providerMap.has(name)) {
        throw new Error(`Provider "${name}" not found`);
      }
      defaultName = name;
    },
    instantiateProviderForChild() {
      throw new Error("not used in proxy tests");
    },
  };
}

describe("proxy server", () => {
  test("requires auth for health and provider inventory endpoints", async () => {
    const exact = createProvider("exact-provider", "openai-compatible", "exact-model", "exact");
    const prefix = createProvider("anthropic-backend", "anthropic", "claude-sonnet-4-20250514", "prefix");
    const fallback = createProvider("fallback-provider", "gemini", "gemini-2.5-flash", "default");
    const registry = createRegistry([exact, prefix, fallback], "fallback-provider");

    const handle = startProxyServer({
      registry,
      port: 0,
      authToken: "secret-token",
      log: () => {},
    });

    try {
      const unauthorized = await fetch(`${handle.url}/health`, {
        headers: { "x-request-id": "req-unauthorized" },
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("x-request-id")).toBe("req-unauthorized");
      expect(await unauthorized.json()).toEqual({
        type: "error",
        error: {
          type: "unauthorized",
          message: "Invalid or missing bearer token",
        },
        requestId: "req-unauthorized",
      });

      const headers = { Authorization: "Bearer secret-token", "x-request-id": "req-health" };

      const health = await fetch(`${handle.url}/health`, { headers });
      expect(health.status).toBe(200);
      expect(health.headers.get("x-request-id")).toBe("req-health");
      expect(await health.json()).toEqual({
        status: "ok",
        providers: ["exact-provider", "anthropic-backend", "fallback-provider"],
        default: "fallback-provider",
      });

      const providers = await fetch(`${handle.url}/v1/providers`, { headers });
      expect(providers.status).toBe(200);
      expect(await providers.json()).toEqual({
        providers: [
          {
            name: "exact-provider",
            type: "openai-compatible",
            model: "exact-model",
            supportsToolCalling: true,
            supportsStreaming: true,
          },
          {
            name: "anthropic-backend",
            type: "anthropic",
            model: "claude-sonnet-4-20250514",
            supportsToolCalling: true,
            supportsStreaming: true,
          },
          {
            name: "fallback-provider",
            type: "gemini",
            model: "gemini-2.5-flash",
            supportsToolCalling: true,
            supportsStreaming: true,
          },
        ],
      });
    } finally {
      handle.stop();
    }
  });

  test("surfaces unsupported hosted tool errors with request tracing", async () => {
    const provider = createToolRejectingProvider("openai-backend", "openai-compatible", "gpt-4o", "ok");
    const registry = createRegistry([provider], "openai-backend");

    const handle = startProxyServer({ registry, port: 0, log: () => {} });

    try {
      const response = await fetch(`${handle.url}/openai/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-hosted-tool",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Use the hosted tool." }],
          tools: [
            {
              type: "web_search",
              name: "web_search",
              external_web_access: true,
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("x-request-id")).toBe("req-hosted-tool");
      expect(await response.json()).toEqual({
        type: "error",
        error: {
          type: "unsupported_hosted_tool",
          message: '[openai-backend] hosted tool "web_search" (web_search) is not supported by this provider.',
        },
        requestId: "req-hosted-tool",
      });
      expect(provider.callCount).toBe(1);
    } finally {
      handle.stop();
    }
  });

  test("routes exact-name, prefix, and default models through the live server", async () => {
    const exact = createProvider("exact-provider", "openai-compatible", "exact-model", "exact");
    const prefix = createProvider("anthropic-backend", "anthropic", "claude-sonnet-4-20250514", "prefix");
    const fallback = createProvider("fallback-provider", "gemini", "gemini-2.5-flash", "default");
    const registry = createRegistry([exact, prefix, fallback], "fallback-provider");

    const handle = startProxyServer({ registry, port: 0, log: () => {} });

    try {
      const headers = { "Content-Type": "application/json" };
      const post = async (model: string) => {
        const response = await fetch(`${handle.url}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with the provider name." }],
          }),
        });
        expect(response.status).toBe(200);
        return response.json() as Promise<Record<string, unknown>>;
      };

      const exactResponse = await post("exact-provider");
      expect(exactResponse).toMatchObject({
        role: "assistant",
        model: "exact-provider",
      });
      expect((exactResponse.content as Array<Record<string, unknown>>)[0]).toEqual({
        type: "text",
        text: "exact",
      });

      const prefixResponse = await post("claude-3-7-sonnet");
      expect(prefixResponse).toMatchObject({
        role: "assistant",
        model: "claude-3-7-sonnet",
      });
      expect((prefixResponse.content as Array<Record<string, unknown>>)[0]).toEqual({
        type: "text",
        text: "prefix",
      });

      const defaultResponse = await post("my-custom-model");
      expect(defaultResponse).toMatchObject({
        role: "assistant",
        model: "my-custom-model",
      });
      expect((defaultResponse.content as Array<Record<string, unknown>>)[0]).toEqual({
        type: "text",
        text: "default",
      });

      expect(exact.callCount).toBe(1);
      expect(prefix.callCount).toBe(1);
      expect(fallback.callCount).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
