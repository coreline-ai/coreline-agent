import { describe, expect, test } from "bun:test";
import { StatusTracker } from "../src/agent/status.js";
import { createStatusStream, createStatusStreamEvent } from "../src/proxy/status-stream.js";
import { validateStatusStreamEvent } from "../src/proxy/platform-types.js";

describe("status stream helper", () => {
  test("creates validated status stream events", () => {
    const event = createStatusStreamEvent("keepalive", {
      message: "ok",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
    });

    expect(validateStatusStreamEvent(event)).toBe(true);
    expect(event.event).toBe("keepalive");
    expect(event.message).toBe("ok");
  });

  test("streams initial snapshot and status changes", async () => {
    const tracker = new StatusTracker({ initial: { status: "idle", mode: "proxy" } });
    const stream = createStatusStream(tracker, { keepaliveMs: 0, now: () => new Date("2026-04-19T00:00:00.000Z") });

    tracker.update("running", { message: "working" });
    stream.close();

    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    const text = await stream.response.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"status":"idle"');
    expect(text).toContain("event: status");
    expect(text).toContain('"status":"running"');
    expect(text).toContain('"message":"working"');
  });

  test("close unsubscribes from later status updates", async () => {
    const tracker = new StatusTracker({ initial: { status: "idle" } });
    const stream = createStatusStream(tracker, { keepaliveMs: 0, includeInitialSnapshot: false });

    stream.close();
    tracker.update("running", { message: "late" });

    const text = await stream.response.text();
    expect(text).toBe("");
  });

  test("status snapshots and SSE preserve optional observability metadata", async () => {
    const tracker = new StatusTracker({
      initial: {
        status: "running",
        provider: "codex",
        model: "gpt-5-codex",
        providerMetadata: {
          providerName: "codex",
          providerType: "codex-backend",
          model: "gpt-5-codex",
          modelDisplayName: "GPT-5 Codex",
          reasoningEffort: "high",
        },
        cost: { totalCost: 0.02, budget: 1, overBudget: false, hasUnknownPricing: false },
        quota: { remaining: 42, limit: 100 },
        statusline: { valid: true, wouldExecute: false, command: "git status", preview: "git status" },
      },
    });
    const stream = createStatusStream(tracker, { keepaliveMs: 0, now: () => new Date("2026-04-19T00:00:00.000Z") });
    stream.close();

    const text = await stream.response.text();
    expect(text).toContain('"modelDisplayName":"GPT-5 Codex"');
    expect(text).toContain('"reasoningEffort":"high"');
    expect(text).toContain('"totalCost":0.02');
    expect(text).toContain('"remaining":42');
    expect(text).toContain('"wouldExecute":false');
  });
});
