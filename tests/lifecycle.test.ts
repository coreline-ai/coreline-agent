import { describe, expect, test } from "bun:test";
import { createLifecycle } from "../src/agent/lifecycle.js";

describe("lifecycle helper", () => {
  test("runs cleanup in reverse order, continues after failure, and destroys only once", async () => {
    const calls: string[] = [];
    const lifecycle = createLifecycle();

    lifecycle.addCleanup(async () => {
      calls.push("first");
    }, "first");
    lifecycle.addCleanup(() => {
      calls.push("second");
      throw new Error("boom");
    }, "second");
    lifecycle.addCleanup(() => {
      calls.push("third");
    }, "third");

    const firstResult = await lifecycle.destroy("manual");
    const secondResult = await lifecycle.destroy("SIGINT");

    expect(calls).toEqual(["third", "second", "first"]);
    expect(firstResult.reason).toBe("manual");
    expect(firstResult.cleanupResults.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(secondResult.reason).toBe("manual");
    expect(secondResult.cleanupResults).toEqual(firstResult.cleanupResults);
  });

  test("dispatches session start/end at most once even across duplicate destroy paths", async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle({
      onSessionStart: (context) => {
        events.push(`start:${context.sessionId ?? "none"}`);
      },
      onSessionEnd: (context) => {
        events.push(`end:${context.reason}:${context.sessionId ?? "none"}`);
      },
    });

    await lifecycle.beginSession({ sessionId: "s-1", metadata: { mode: "chat" } });
    await lifecycle.beginSession({ sessionId: "s-2" });

    await Promise.all([
      lifecycle.destroy("SIGINT"),
      lifecycle.destroy("SIGTERM"),
      lifecycle.destroy("beforeExit"),
    ]);

    expect(events).toEqual(["start:s-1", "end:SIGINT:s-1"]);
  });

  test("removeCleanup prevents execution", async () => {
    const calls: string[] = [];
    const lifecycle = createLifecycle();

    const remove = lifecycle.addCleanup(() => {
      calls.push("cleanup");
    }, "cleanup");

    remove();
    await lifecycle.destroy("manual");

    expect(calls).toEqual([]);
  });
});
