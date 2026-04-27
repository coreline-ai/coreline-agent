import { describe, expect, test } from "bun:test";
import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  ProviderRegistry,
} from "../src/providers/types.js";
import { dispatchProxyRequest } from "../src/proxy/server.js";

function toStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function createProvider(
  name: string,
  type: LLMProvider["type"],
  model: string,
  responseText = "ok",
): LLMProvider & { callCount: number } {
  let callCount = 0;

  return {
    name,
    type,
    model,
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsPlanning: false,
    get callCount() {
      return callCount;
    },
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      callCount += 1;
      yield* toStream([
        { type: "text_delta", text: responseText },
        {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: "end_turn",
        },
      ]);
    },
  };
}

function createRegistry(
  providers: Array<LLMProvider & { callCount: number }>,
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
        baseUrl: provider.type === "openai-compatible" ? "http://localhost:11434/v1" : undefined,
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
      throw new Error("not used in proxy human input tests");
    },
  };
}

function noopLog(): void {}

describe("proxy human input mode", () => {
  test("returns 409 human_input_required for return mode with interactive hosted tools", async () => {
    const anthropic = createProvider("claude-sonnet-4", "anthropic", "claude-sonnet-4");
    const registry = createRegistry([anthropic], "claude-sonnet-4");

    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/anthropic/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-return" },
        body: JSON.stringify({
          model: "claude-sonnet-4",
          messages: [{ role: "user", content: "search the web" }],
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 3,
            },
          ],
          human_input_mode: "return",
        }),
      }),
      { registry },
      noopLog,
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-request-id")).toBe("req-return");
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "human_input_required",
      },
      requestId: "req-return",
    });
    expect(anthropic.callCount).toBe(0);
  });

  test("keeps forbid mode on the legacy 400 path", async () => {
    const openai = createProvider("gpt-5", "openai-compatible", "gpt-5");
    const registry = createRegistry([openai], "gpt-5");

    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/openai/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-forbid" },
        body: JSON.stringify({
          model: "gpt-5",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
          tools: [
            {
              type: "web_search",
              external_web_access: false,
            },
          ],
          human_input_mode: "forbid",
        }),
      }),
      { registry },
      noopLog,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("req-forbid");
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "unsupported_human_input_mode",
      },
      requestId: "req-forbid",
    });
    expect(openai.callCount).toBe(0);
  });

  test("propagates return mode through batch with a 409 item response", async () => {
    const anthropic = createProvider("claude-sonnet-4", "anthropic", "claude-sonnet-4");
    const registry = createRegistry([anthropic], "claude-sonnet-4");

    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-batch" },
        body: JSON.stringify({
          requests: [
            {
              id: "human",
              method: "POST",
              path: "/anthropic/v1/messages",
              body: {
                model: "claude-sonnet-4",
                messages: [{ role: "user", content: "search the web" }],
                tools: [
                  {
                    type: "web_search_20250305",
                    name: "web_search",
                    max_uses: 3,
                  },
                ],
                human_input_mode: "return",
              },
            },
          ],
        }),
      }),
      { registry },
      noopLog,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.type).toBe("batch_response");
    expect(body.requestId).toBe("req-batch");
    expect(body.results[0]).toMatchObject({
      id: "human",
      status: 409,
      ok: false,
      requestId: "req-batch.b1",
      body: {
        type: "error",
        error: {
          type: "human_input_required",
        },
      },
    });
    expect(anthropic.callCount).toBe(0);
  });
});
