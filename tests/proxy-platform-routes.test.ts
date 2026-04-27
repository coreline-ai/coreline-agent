import { describe, expect, test } from "bun:test";
import type { ChatChunk, ChatRequest, LLMProvider, ProviderConfig, ProviderRegistry } from "../src/providers/types.js";
import { StatusTracker } from "../src/agent/status.js";
import { dispatchProxyRequest } from "../src/proxy/server.js";

function provider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock",
    maxContextTokens: 1000,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsPlanning: false,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" };
    },
  };
}

function registry(): ProviderRegistry {
  const p = provider();
  const config: ProviderConfig = { name: "mock", type: "openai-compatible", model: "mock", baseUrl: "http://127.0.0.1:1" };
  return {
    getProvider: () => p,
    getProviderConfig: () => ({ ...config }),
    listProviders: () => ["mock"],
    getDefault: () => p,
    getDefaultProviderConfig: () => ({ ...config }),
    setDefault: () => {},
    instantiateProviderForChild: () => p,
  };
}

const log = () => {};

describe("proxy platform route integration", () => {
  test("mounts A2A discovery and disabled task send", async () => {
    const card = await dispatchProxyRequest(new Request("http://proxy.local/.well-known/agent.json"), { registry: registry() }, log);
    expect(card.status).toBe(200);
    expect((await card.json()).type).toBe("agent_card");

    const task = await dispatchProxyRequest(new Request("http://proxy.local/a2a/tasks/send", {
      method: "POST",
      body: JSON.stringify({ input: "hello" }),
      headers: { "content-type": "application/json" },
    }), { registry: registry() }, log);
    expect(task.status).toBe(202);
    expect((await task.json()).status).toBe("disabled");
  });

  test("mounts read-only dashboard", async () => {
    const response = await dispatchProxyRequest(new Request("http://proxy.local/dashboard"), {
      registry: registry(),
      statusTracker: new StatusTracker({ initial: { status: "idle", mode: "proxy" } }),
    }, log);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Read-only status shell");
    expect(html).not.toContain("<form");
  });
});
