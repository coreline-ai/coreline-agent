import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { executeFunctionHook, executeHttpHook, validateHookUrl } from "../src/hooks/index.js";
import type { FunctionHookConfig, HttpHookConfig } from "../src/hooks/index.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

function functionHook(config: Partial<FunctionHookConfig> = {}): FunctionHookConfig & { id: string } {
  return {
    id: "fn-1",
    type: "function",
    event: "PreTool",
    handler: () => undefined,
    ...config,
  };
}

function httpHook(url: string, config: Partial<HttpHookConfig> = {}): HttpHookConfig & { id: string } {
  return {
    id: "http-1",
    type: "http",
    event: "PreTool",
    url,
    ...config,
  };
}

async function localServer(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected address");
  return `http://127.0.0.1:${address.port}`;
}

describe("hook executors", () => {
  test("function hook succeeds and reports blocking", async () => {
    const result = await executeFunctionHook(
      functionHook({ handler: () => ({ blocking: true, message: "stop" }) }),
      { event: "PreTool", toolName: "Bash" },
    );
    expect(result.blocking).toBe(true);
    expect(result.message).toBe("stop");
  });

  test("function hook failures are captured", async () => {
    const result = await executeFunctionHook(
      functionHook({ handler: () => { throw new Error("fn failed"); } }),
      { event: "PreTool", toolName: "Bash" },
    );
    expect(result.blocking).toBe(false);
    expect(result.error).toContain("fn failed");
  });

  test("HTTP hook succeeds and reports blocking", async () => {
    const url = await localServer((req, res) => {
      expect(req.method).toBe("POST");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ blocking: true, message: "blocked remotely" }));
    });

    const result = await executeHttpHook(httpHook(url), { event: "PreTool", toolName: "Bash" });
    expect(result.blocking).toBe(true);
    expect(result.message).toBe("blocked remotely");
  });

  test("HTTP non-2xx is captured as an error", async () => {
    const url = await localServer((_req, res) => {
      res.statusCode = 500;
      res.end("nope");
    });

    const result = await executeHttpHook(httpHook(url), { event: "PreTool", toolName: "Bash" });
    expect(result.blocking).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  test("HTTP hook blocks external URLs by default", async () => {
    expect(validateHookUrl("https://example.com/hook").ok).toBe(false);
    const result = await executeHttpHook(httpHook("https://example.com/hook"), { event: "PreTool", toolName: "Bash" });
    expect(result.error).toContain("external hook host not allowed");
  });

  test("HTTP hook permits explicit allowlist hosts", () => {
    expect(validateHookUrl("https://example.com/hook", ["example.com"]).ok).toBe(true);
  });

  test("HTTP hook timeouts are captured", async () => {
    const url = await localServer((_req, _res) => {
      // Keep request open until client timeout.
    });
    const result = await executeHttpHook(httpHook(url, { timeoutMs: 10 }), { event: "PreTool", toolName: "Bash" });
    expect(result.blocking).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
