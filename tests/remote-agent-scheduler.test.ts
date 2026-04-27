/**
 * Remote scheduler tests — verifies windowed parallelism, retry, abort,
 * and partial failure handling.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { RemoteScheduler } from "../src/agent/remote/scheduler.js";
import type { RemoteAgentEndpoint } from "../src/agent/remote/types.js";

// ---------------------------------------------------------------------------
// Mock server with controllable behavior
// ---------------------------------------------------------------------------

let mockPort: number;
let mockServer: ReturnType<typeof Bun.serve>;
let requestCount = 0;
let concurrentCount = 0;
let maxConcurrentSeen = 0;

function startMockServer() {
  requestCount = 0;
  concurrentCount = 0;
  maxConcurrentSeen = 0;

  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        concurrentCount++;
        if (concurrentCount > maxConcurrentSeen) {
          maxConcurrentSeen = concurrentCount;
        }
        requestCount++;
        const currentRequest = requestCount;

        const body = (await req.json()) as Record<string, unknown>;
        const prompt = ((body.messages as Array<{ content: string }>)?.[0]?.content) ?? "";

        // Small delay to observe concurrency
        await new Promise((resolve) => setTimeout(resolve, 20));

        concurrentCount--;

        if (prompt.includes("fail_once") && currentRequest === 1) {
          return new Response("First attempt fails", { status: 500 });
        }
        if (prompt.includes("always_fail")) {
          return new Response("Always fails", { status: 500 });
        }

        return Response.json({
          id: `msg_${currentRequest}`,
          type: "message",
          role: "assistant",
          model: "mock-model",
          content: [{ type: "text", text: `Result #${currentRequest}: ${prompt}` }],
          usage: { input_tokens: 5, output_tokens: 10 },
        });
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

function makeEndpoint(name = "mock"): RemoteAgentEndpoint {
  return {
    name,
    url: `http://127.0.0.1:${mockPort}`,
    healthy: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RemoteScheduler", () => {
  test("TC-6.5: respects maxConcurrent window (3 tasks, max 2)", async () => {
    // Reset counters
    requestCount = 0;
    concurrentCount = 0;
    maxConcurrentSeen = 0;

    const scheduler = new RemoteScheduler({
      endpoints: [makeEndpoint()],
      maxConcurrent: 2,
      retry: { maxRetries: 0, backoffMs: 0 },
      defaultTimeoutMs: 5000,
    });

    const result = await scheduler.schedule([
      { prompt: "task 1" },
      { prompt: "task 2" },
      { prompt: "task 3" },
    ]);

    expect(result.results).toHaveLength(3);
    expect(result.completedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.partial).toBe(false);
    // With max 2, we should never have more than 2 concurrent
    expect(maxConcurrentSeen).toBeLessThanOrEqual(2);
  });

  test("TC-6.6: reports partial failure (1 fail + 2 success)", async () => {
    requestCount = 0;

    const scheduler = new RemoteScheduler({
      endpoints: [makeEndpoint()],
      maxConcurrent: 4,
      retry: { maxRetries: 0, backoffMs: 0 },
      defaultTimeoutMs: 5000,
    });

    const result = await scheduler.schedule([
      { prompt: "always_fail task" },
      { prompt: "good task 1" },
      { prompt: "good task 2" },
    ]);

    expect(result.results).toHaveLength(3);
    expect(result.completedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.partial).toBe(true);

    const failed = result.results.find((r) => r.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.error).toContain("500");
  });

  test("TC-6.7: retry policy retries failed task once then succeeds", async () => {
    requestCount = 0;

    const scheduler = new RemoteScheduler({
      endpoints: [makeEndpoint()],
      maxConcurrent: 1,
      retry: { maxRetries: 1, backoffMs: 10 },
      defaultTimeoutMs: 5000,
    });

    const result = await scheduler.schedule([
      { prompt: "fail_once then succeed" },
    ]);

    expect(result.results).toHaveLength(1);
    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    // Should have made 2 HTTP requests (1 fail + 1 retry success)
    expect(requestCount).toBe(2);
  });

  test("TC-6.8: parent abort cancels all pending tasks", async () => {
    const scheduler = new RemoteScheduler({
      endpoints: [makeEndpoint()],
      maxConcurrent: 1,
      retry: { maxRetries: 0, backoffMs: 0 },
      defaultTimeoutMs: 30_000,
    });

    const controller = new AbortController();

    // Abort quickly so later tasks don't dispatch
    setTimeout(() => controller.abort(), 10);

    const result = await scheduler.schedule(
      [
        { prompt: "task 1" },
        { prompt: "task 2" },
        { prompt: "task 3" },
      ],
      controller.signal,
    );

    // Some tasks should be aborted (at least the later ones)
    const abortedCount = result.results.filter((r) => r.status === "aborted").length;
    expect(abortedCount).toBeGreaterThanOrEqual(1);
  });

  test("empty task list returns empty result", async () => {
    const scheduler = new RemoteScheduler({
      endpoints: [makeEndpoint()],
      maxConcurrent: 4,
    });

    const result = await scheduler.schedule([]);
    expect(result.results).toHaveLength(0);
    expect(result.completedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.partial).toBe(false);
  });

  test("refreshHealth marks unreachable endpoints", async () => {
    const scheduler = new RemoteScheduler({
      endpoints: [
        makeEndpoint("good"),
        { name: "bad", url: "http://127.0.0.1:1", healthy: true },
      ],
      maxConcurrent: 2,
    });

    const healthyCount = await scheduler.refreshHealth();
    expect(healthyCount).toBe(1); // only the mock server is reachable
    expect(scheduler.healthyCount).toBe(1);
  });
});
