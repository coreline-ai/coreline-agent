import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatChunk, ChatRequest, LLMProvider, ProviderConfig, ProviderRegistry } from "../src/providers/types.js";
import { dispatchProxyRequest } from "../src/proxy/server.js";
import { StatusTracker, readStatusSnapshot } from "../src/agent/status.js";

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
  ]);

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
      return this.getProvider("mock-openai");
    },
    getDefaultProviderConfig(): ProviderConfig {
      return this.getProviderConfig("mock-openai");
    },
    setDefault(name: string): void {
      if (!providers.has(name)) throw new Error(`Provider "${name}" not found`);
      void name;
    },
    instantiateProviderForChild(baseName: string, override?: { provider?: string; model?: string }): LLMProvider {
      const selected = this.getProvider(override?.provider ?? baseName);
      return {
        ...selected,
        name: override?.provider ?? baseName,
        model: override?.model ?? selected.model,
      };
    },
  };
}

function noopLog(): void {}

describe("coreline proxy hooks", () => {
  test("POST /hook/coreline/start updates running status with metadata", async () => {
    const registry = createMockRegistry();
    const dir = mkdtempSync(join(tmpdir(), "coreline-hooks-"));
    const statusPath = join(dir, "status.json");
    try {
      const statusTracker = new StatusTracker({ statusPath, initial: { status: "idle" } });
      const response = await dispatchProxyRequest(
        new Request("http://proxy.local/hook/coreline/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "req-start" },
          body: JSON.stringify({
            sessionId: "session-1",
            provider: "mock-openai",
            model: "mock-openai",
            mode: "autopilot",
            cwd: "/work/coreline-agent",
          }),
        }),
        { registry, statusTracker },
        noopLog,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hook).toBe("start");
      expect(body.status).toBe("running");
      expect(body.statusSnapshot.sessionId).toBe("session-1");
      expect(body.statusSnapshot.provider).toBe("mock-openai");
      expect(body.statusSnapshot.mode).toBe("autopilot");

      const persisted = readStatusSnapshot(statusPath);
      expect(persisted?.status).toBe("running");
      expect(persisted?.sessionId).toBe("session-1");
      expect(persisted?.cwd).toBe("/work/coreline-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POST /hook/coreline/stop marks the session as aborted when requested", async () => {
    const registry = createMockRegistry();
    const dir = mkdtempSync(join(tmpdir(), "coreline-hooks-"));
    const statusPath = join(dir, "status.json");
    try {
      const statusTracker = new StatusTracker({
        statusPath,
        initial: { status: "running", mode: "autopilot", sessionId: "session-2" },
      });
      const response = await dispatchProxyRequest(
        new Request("http://proxy.local/hook/coreline/stop", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "req-stop" },
          body: JSON.stringify({
            sessionId: "session-2",
            provider: "mock-openai",
            model: "mock-openai",
            reason: "user aborted",
            aborted: true,
          }),
        }),
        { registry, statusTracker },
        noopLog,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hook).toBe("stop");
      expect(body.status).toBe("aborted");

      const persisted = readStatusSnapshot(statusPath);
      expect(persisted?.status).toBe("aborted");
      expect(persisted?.sessionId).toBe("session-2");
      expect(persisted?.provider).toBe("mock-openai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POST /hook/coreline/idle returns 200 and updates idle status", async () => {
    const registry = createMockRegistry();
    const dir = mkdtempSync(join(tmpdir(), "coreline-hooks-"));
    const statusPath = join(dir, "status.json");
    try {
      const statusTracker = new StatusTracker({
        statusPath,
        initial: { status: "running", mode: "plan", sessionId: "session-3" },
      });
      const response = await dispatchProxyRequest(
        new Request("http://proxy.local/hook/coreline/idle", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "req-idle" },
          body: JSON.stringify({
            sessionId: "session-3",
            mode: "plan",
            message: "waiting for input",
          }),
        }),
        { registry, statusTracker },
        noopLog,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hook).toBe("idle");
      expect(body.status).toBe("idle");

      const persisted = readStatusSnapshot(statusPath);
      expect(persisted?.status).toBe("idle");
      expect(persisted?.mode).toBe("plan");
      expect(persisted?.message).toBe("waiting for input");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET /v2/status keeps hook metadata discoverable", async () => {
    const registry = createMockRegistry();
    const response = await dispatchProxyRequest(
      new Request("http://proxy.local/v2/status", {
        method: "GET",
        headers: { "x-request-id": "req-status" },
      }),
      { registry, statusTracker: new StatusTracker({ initial: { status: "running" } }) },
      noopLog,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.type).toBe("agent_status");
    expect(body.hooks.start).toBe("/hook/coreline/start");
    expect(body.hooks.stop).toBe("/hook/coreline/stop");
    expect(body.hooks.idle).toBe("/hook/coreline/idle");
  });
});
