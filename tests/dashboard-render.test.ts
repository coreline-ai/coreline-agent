import { describe, expect, test } from "bun:test";
import { handleDashboardRequest, renderDashboardHtml } from "../src/dashboard/index.js";

const status = {
  status: "running" as const,
  mode: "proxy" as const,
  lastActivity: "2026-04-19T00:00:00.000Z",
  pid: 1,
  startedAt: "2026-04-19T00:00:00.000Z",
  uptimeMs: 100,
  provider: "mock",
  model: "m1",
};

describe("dashboard renderer", () => {
  test("renders a read-only HTML shell with status consumers", () => {
    const html = renderDashboardHtml({ status });

    expect(html).toContain("coreline-agent dashboard");
    expect(html).toContain("/v2/status");
    expect(html).toContain("/v2/status/stream");
    expect(html).toContain("EventSource");
    expect(html).toContain("mock");
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<input\b/i);
    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/method=["']?post/i);
  });

  test("handleDashboardRequest returns HTML response", async () => {
    const response = handleDashboardRequest({ status });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain("Raw snapshot");
  });
});
