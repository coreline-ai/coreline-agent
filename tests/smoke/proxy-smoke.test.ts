import { describe, expect, test } from "bun:test";
import type { ChatChunk, ChatRequest, LLMProvider, ProviderConfig, ProviderRegistry } from "../../src/providers/types.js";
import { StatusTracker } from "../../src/agent/status.js";
import { dispatchProxyRequest } from "../../src/proxy/server.js";

function mockProvider(): LLMProvider {
  return {
    name: "mock-openai",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsPlanning: false,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: "text_delta", text: "pong" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" };
    },
  };
}

function mockRegistry(): ProviderRegistry {
  const provider = mockProvider();
  const config: ProviderConfig = {
    name: provider.name,
    type: provider.type,
    model: provider.model,
    baseUrl: "http://127.0.0.1:1",
  };
  return {
    getProvider(name: string) {
      if (name !== provider.name) throw new Error(`Provider "${name}" not found`);
      return provider;
    },
    getProviderConfig(name: string) {
      if (name !== provider.name) throw new Error(`Provider config "${name}" not found`);
      return config;
    },
    listProviders() {
      return [provider.name];
    },
    getDefault() {
      return provider;
    },
    getDefaultProviderConfig() {
      return config;
    },
    setDefault(name: string) {
      if (name !== provider.name) throw new Error(`Provider "${name}" not found`);
    },
    instantiateProviderForChild(_baseName: string, override?: { provider?: string; model?: string }) {
      return { ...provider, name: override?.provider ?? provider.name, model: override?.model ?? provider.model };
    },
  };
}

async function json(req: Request, statusTracker = new StatusTracker({ initial: { status: "idle", mode: "proxy" } })) {
  const response = await dispatchProxyRequest(req, { registry: mockRegistry(), statusTracker }, () => undefined);
  return { response, body: await response.json() as any };
}

describe("proxy smoke", () => {
  test("health, status, capabilities, and coreline hooks work without external LLM calls", async () => {
    const statusTracker = new StatusTracker({ initial: { status: "idle", mode: "proxy", provider: "mock-openai" } });

    const health = await json(new Request("http://proxy.local/health"), statusTracker);
    expect(health.response.status).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.providers).toEqual(["mock-openai"]);

    const capabilities = await json(new Request("http://proxy.local/v2/capabilities"), statusTracker);
    expect(capabilities.response.status).toBe(200);
    expect(capabilities.body.type).toBe("proxy_capabilities");
    expect(capabilities.body.proxy.status.supported).toBe(true);

    const start = await json(new Request("http://proxy.local/hook/coreline/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "smoke-session", mode: "autopilot", message: "started" }),
    }), statusTracker);
    expect(start.response.status).toBe(200);
    expect(start.body.status).toBe("running");

    const status = await json(new Request("http://proxy.local/v2/status"), statusTracker);
    expect(status.response.status).toBe(200);
    expect(status.body.available).toBe(true);
    expect(status.body.status.sessionId).toBe("smoke-session");
    expect(status.body.hooks.start).toBe("/hook/coreline/start");

    const idle = await json(new Request("http://proxy.local/hook/coreline/idle", { method: "POST" }), statusTracker);
    expect(idle.response.status).toBe(200);
    expect(idle.body.status).toBe("idle");

    const stop = await json(new Request("http://proxy.local/hook/coreline/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "aborted", message: "stopped" }),
    }), statusTracker);
    expect(stop.response.status).toBe(200);
    expect(stop.body.status).toBe("aborted");
  });
});
