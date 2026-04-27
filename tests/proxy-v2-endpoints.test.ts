import { describe, expect, test } from "bun:test";
import type { ChatChunk, ChatRequest, LLMProvider, ProviderConfig, ProviderRegistry } from "../src/providers/types.js";
import { dispatchProxyRequest } from "../src/proxy/server.js";
import { StatusTracker } from "../src/agent/status.js";

function mockProvider(
  name: string,
  type: LLMProvider["type"],
  model: string,
  text: string,
): LLMProvider {
  return {
    name,
    type,
    model,
    maxContextTokens: 100000,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsPlanning: false,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: "text_delta", text };
      yield {
        type: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn",
      };
    },
  };
}

function createMockRegistry(): ProviderRegistry {
  const providers = new Map<string, LLMProvider>([
    ["mock-openai", mockProvider("mock-openai", "openai-compatible", "mock-openai", "pong")],
    ["mock-anthropic", mockProvider("mock-anthropic", "anthropic", "claude-sonnet-test", "hi")],
  ]);

  const configs = new Map<string, ProviderConfig>([
    [
      "mock-openai",
      {
        name: "mock-openai",
        type: "openai-compatible",
        model: "mock-openai",
        baseUrl: "http://127.0.0.1:1",
      },
    ],
    [
      "mock-anthropic",
      {
        name: "mock-anthropic",
        type: "anthropic",
        model: "claude-sonnet-test",
        apiKey: "sk-test",
      },
    ],
  ]);

  let defaultName = "mock-openai";

  return {
    getProvider(name: string): LLMProvider {
      const provider = providers.get(name);
      if (!provider) throw new Error(`Provider "${name}" not found`);
      return provider;
    },
    getProviderConfig(name: string): ProviderConfig {
      const config = configs.get(name);
      if (!config) throw new Error(`Provider config "${name}" not found`);
      return { ...config };
    },
    listProviders(): string[] {
      return [...providers.keys()];
    },
    getDefault(): LLMProvider {
      return this.getProvider(defaultName);
    },
    getDefaultProviderConfig(): ProviderConfig {
      return this.getProviderConfig(defaultName);
    },
    setDefault(name: string): void {
      if (!providers.has(name)) throw new Error(`Provider "${name}" not found`);
      defaultName = name;
    },
    instantiateProviderForChild(baseName: string, override?: { provider?: string; model?: string }): LLMProvider {
      const selectedName = override?.provider ?? baseName;
      const selected = this.getProvider(selectedName);
      return {
        ...selected,
        name: selectedName,
        model: override?.model ?? selected.model,
      };
    },
  };
}

function noopLog(): void {}

describe("proxy v2 endpoints", () => {
  test("GET /v2/capabilities exposes v2 discovery data", async () => {
    const registry = createMockRegistry();
    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/capabilities", {
        method: "GET",
        headers: { "x-request-id": "req-capabilities" },
      }),
      { registry },
      noopLog,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toBe("req-capabilities");

    const body = await response.json();
    expect(body.type).toBe("proxy_capabilities");
    expect(body.version).toBe("v2");
    expect(body.defaultProvider).toBe("mock-openai");
    expect(body.proxy.auth.required).toBe(false);
    expect(body.proxy.requestTracing).toBe(true);
    expect(body.proxy.batch.supported).toBe(true);
    expect(body.proxy.batch.maxItems).toBe(8);
    expect(body.proxy.batch.maxConcurrency).toBe(4);
    expect(body.proxy.batch.timeoutMs).toBe(30000);
    expect(body.proxy.humanInputMode.supported).toBe(true);
    expect(body.proxy.humanInputMode.policy).toBe("return-or-forbid");
    expect(body.proxy.status.supported).toBe(true);
    expect(body.proxy.status.path).toBe("/v2/status");
    expect(body.endpoints.some((entry: any) => entry.path === "/v2/batch")).toBe(true);
    expect(body.endpoints.some((entry: any) => entry.path === "/v2/status")).toBe(true);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0].capabilities.batch).toBe(true);
    expect(body.providers[0].capabilities.streaming).toBe(true);
  });


  test("GET /v2/status exposes the current agent status snapshot", async () => {
    const registry = createMockRegistry();
    const statusTracker = new StatusTracker({
      initial: { status: "running", mode: "autopilot", sessionId: "s1", provider: "mock-openai", model: "mock-openai" },
    });

    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/status", {
        method: "GET",
        headers: { "x-request-id": "req-status" },
      }),
      { registry, statusTracker },
      noopLog,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-status");
    const body = await response.json();
    expect(body.type).toBe("agent_status");
    expect(body.available).toBe(true);
    expect(body.status.status).toBe("running");
    expect(body.status.mode).toBe("autopilot");
    expect(body.status.sessionId).toBe("s1");
    expect(body.hooks.start).toBe("/hook/coreline/start");
  });

  test("POST /v2/batch fans out requests and preserves partial failures", async () => {
    const registry = createMockRegistry();
    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-batch" },
        body: JSON.stringify({
          requests: [
            { id: "health", method: "GET", path: "/health" },
            {
              id: "chat",
              method: "POST",
              path: "/openai/v1/chat/completions",
              body: {
                model: "mock-openai",
                messages: [{ role: "user", content: "say pong" }],
                stream: false,
              },
            },
            { id: "missing", method: "GET", path: "/v2/does-not-exist" },
          ],
        }),
      }),
      { registry },
      noopLog,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.type).toBe("batch_response");
    expect(body.count).toBe(3);
    expect(body.requestId).toBe("req-batch");

    const byId = new Map(body.results.map((item: any) => [item.id, item]));
    expect(byId.get("health")?.status).toBe(200);
    expect(byId.get("health")?.body.status).toBe("ok");
    expect(byId.get("health")?.requestId).toBe("req-batch.b1");

    expect(byId.get("chat")?.status).toBe(200);
    expect(byId.get("chat")?.body.object).toBe("chat.completion");
    expect(byId.get("chat")?.body.choices[0].message.content).toBe("pong");

    expect(byId.get("missing")?.status).toBe(404);
    expect(byId.get("missing")?.body.error.type).toBe("not_found");
  });

  test("rejects batch items above the configured limit and human input mode requests", async () => {
    const registry = createMockRegistry();

    const limitResponse = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-limit" },
        body: JSON.stringify({
          requests: [
            { method: "GET", path: "/health" },
            { method: "GET", path: "/v1/providers" },
          ],
        }),
      }),
      { registry, maxBatchItems: 1 },
      noopLog,
    );

    expect(limitResponse.status).toBe(413);
    expect(limitResponse.headers.get("x-request-id")).toBe("req-limit");
    const limitBody = await limitResponse.json();
    expect(limitBody.error.type).toBe("batch_limit_exceeded");

    const humanInputResponse = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-human" },
        body: JSON.stringify({
          requests: [
            {
              id: "human",
              method: "POST",
              path: "/openai/v1/chat/completions",
              body: {
                model: "mock-openai",
                messages: [{ role: "user", content: "hello" }],
                human_input_mode: "enabled",
              },
            },
          ],
        }),
      }),
      { registry },
      noopLog,
    );

    expect(humanInputResponse.status).toBe(200);
    const humanBody = await humanInputResponse.json();
    expect(humanBody.results[0].status).toBe(400);
    expect(humanBody.results[0].body.error.type).toBe("unsupported_human_input_mode");
  });

  test("applies per-item batch timeout", async () => {
    const slowProvider: LLMProvider = {
      name: "slow-openai",
      type: "openai-compatible",
      model: "slow",
      maxContextTokens: 100_000,
      supportsToolCalling: true,
      supportsStreaming: true,
      supportsPlanning: false,
      async *send() {
        await new Promise(() => {});
      },
    };

    const registry = {
      ...createMockRegistry(),
      listProviders: () => ["slow-openai"],
      getProvider: () => slowProvider,
      getDefault: () => slowProvider,
      getDefaultProviderConfig: () => ({
        name: "slow-openai",
        type: "openai-compatible",
        model: "slow",
        baseUrl: "http://127.0.0.1:1",
      }),
      getProviderConfig: () => ({
        name: "slow-openai",
        type: "openai-compatible",
        model: "slow",
        baseUrl: "http://127.0.0.1:1",
      }),
      setDefault: () => undefined,
      instantiateProviderForChild: () => slowProvider,
    } as ProviderRegistry;

    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "req-timeout" },
        body: JSON.stringify({
          requests: [
            {
              id: "slow",
              method: "POST",
              path: "/openai/v1/chat/completions",
              body: {
                model: "slow",
                messages: [{ role: "user", content: "hello" }],
              },
            },
          ],
        }),
      }),
      { registry, batchTimeoutMs: 10 },
      noopLog,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[0].status).toBe(504);
    expect(body.results[0].body.error.type).toBe("batch_item_timeout");
  });

  test("auth and CORS behavior stay consistent on v2 endpoints", async () => {
    const registry = createMockRegistry();

    const optionsResponse = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/batch", { method: "OPTIONS" }),
      { registry, authToken: "secret-token" },
      noopLog,
    );
    expect(optionsResponse.status).toBe(200);
    expect(optionsResponse.headers.get("access-control-allow-origin")).toBe("*");

    const unauthorized = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/capabilities", { method: "GET" }),
      { registry, authToken: "secret-token" },
      noopLog,
    );
    expect(unauthorized.status).toBe(401);
    const body = await unauthorized.json();
    expect(body.error.type).toBe("unauthorized");
  });
});
