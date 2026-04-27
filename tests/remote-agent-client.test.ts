/**
 * Remote agent client tests — verifies sendRemoteTask() and checkEndpointHealth()
 * against a real Bun.serve mock server.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { sendRemoteTask, checkEndpointHealth } from "../src/agent/remote/client.js";
import type { RemoteAgentEndpoint } from "../src/agent/remote/types.js";

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

let mockPort: number;
let mockServer: ReturnType<typeof Bun.serve>;

function startMockServer() {
  mockServer = Bun.serve({
    port: 0, // random port
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const prompt = ((body.messages as Array<{ content: string }>)?.[0]?.content) ?? "";

        // Behavior driven by prompt content
        if (prompt.includes("error500")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        if (prompt.includes("auth_fail")) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (prompt.includes("slow")) {
          // Delay longer than any test timeout
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          return Response.json({});
        }

        return Response.json(
          {
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: body.model ?? "mock-model",
            content: [{ type: "text", text: `Response for: ${prompt}` }],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
          { headers: { "x-request-id": "req_mock_123" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  mockPort = mockServer.port;
}

startMockServer();

afterAll(() => {
  mockServer.stop(true);
});

function makeEndpoint(overrides?: Partial<RemoteAgentEndpoint>): RemoteAgentEndpoint {
  return {
    name: "test-remote",
    url: `http://127.0.0.1:${mockPort}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendRemoteTask", () => {
  test("TC-6.1: sends task and parses successful response", async () => {
    const result = await sendRemoteTask({
      endpoint: makeEndpoint(),
      task: { prompt: "Hello world" },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("Response for: Hello world");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.model).toBe("default");
    expect(result.requestId).toBe("req_mock_123");
    expect(result.endpoint).toBe("test-remote");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("TC-6.2: timeout returns timeout status", async () => {
    const result = await sendRemoteTask({
      endpoint: makeEndpoint(),
      task: { prompt: "slow request" },
      timeoutMs: 50,
    });

    expect(result.status).toBe("timeout");
    expect(result.error).toContain("Timeout");
    expect(result.text).toBe("");
  });

  test("TC-6.3: server error 500 returns failed status", async () => {
    const result = await sendRemoteTask({
      endpoint: makeEndpoint(),
      task: { prompt: "error500" },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 500");
    expect(result.text).toBe("");
  });

  test("TC-6.4: abort signal cancels pending request", async () => {
    const controller = new AbortController();
    const promise = sendRemoteTask({
      endpoint: makeEndpoint(),
      task: { prompt: "slow request" },
      signal: controller.signal,
      timeoutMs: 30_000,
    });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 30);
    const result = await promise;

    expect(result.status).toBe("aborted");
    expect(result.error).toContain("Aborted");
  });

  test("pre-aborted signal returns immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await sendRemoteTask({
      endpoint: makeEndpoint(),
      task: { prompt: "should not send" },
      signal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.error).toContain("Aborted before start");
  });

  test("unreachable endpoint returns failed", async () => {
    const result = await sendRemoteTask({
      endpoint: makeEndpoint({ url: "http://127.0.0.1:1" }),
      task: { prompt: "unreachable" },
      timeoutMs: 2000,
    });

    expect(["failed", "timeout"]).toContain(result.status);
  });
});

describe("checkEndpointHealth", () => {
  test("returns true for healthy endpoint", async () => {
    const healthy = await checkEndpointHealth(makeEndpoint());
    expect(healthy).toBe(true);
  });

  test("returns false for unreachable endpoint", async () => {
    const healthy = await checkEndpointHealth(
      makeEndpoint({ url: "http://127.0.0.1:1" }),
      500,
    );
    expect(healthy).toBe(false);
  });
});
