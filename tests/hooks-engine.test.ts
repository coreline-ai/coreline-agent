import { describe, expect, test } from "bun:test";
import { createHookEngine } from "../src/hooks/index.js";

describe("HookEngine", () => {
  test("registers, lists, and unregisters hooks", () => {
    const engine = createHookEngine({ idPrefix: "t" });
    const id = engine.register({ type: "function", event: "StatusChange", handler: () => undefined });
    expect(id).toBe("t-1");
    expect(engine.getHooks()).toHaveLength(1);
    expect(engine.unregister(id)).toBe(true);
    expect(engine.getHooks()).toHaveLength(0);
  });

  test("executes matching hooks only", async () => {
    const engine = createHookEngine();
    let count = 0;
    engine.register({ type: "function", event: "StatusChange", handler: () => { count += 1; } });
    engine.register({ type: "function", event: "PreTool", handler: () => { count += 10; } });

    const results = await engine.execute("StatusChange", { event: "StatusChange", status: "running" });
    expect(results).toHaveLength(1);
    expect(count).toBe(1);
  });

  test("removes once hooks after execution", async () => {
    const engine = createHookEngine();
    engine.register({ type: "function", event: "StatusChange", once: true, handler: () => undefined });
    await engine.execute("StatusChange", { event: "StatusChange", status: "running" });
    expect(engine.getHooks()).toHaveLength(0);
  });

  test("collects hook failures without throwing", async () => {
    const engine = createHookEngine();
    engine.register({ type: "function", event: "StatusChange", handler: () => { throw new Error("boom"); } });
    const results = await engine.execute("StatusChange", { event: "StatusChange", status: "running" });
    expect(results).toHaveLength(1);
    expect(results[0]?.blocking).toBe(false);
    expect(results[0]?.error).toContain("boom");
  });

  test("collects blocking results", async () => {
    const engine = createHookEngine();
    engine.register({
      type: "function",
      event: "PreTool",
      handler: () => ({ blocking: true, message: "blocked" }),
    });
    const results = await engine.execute("PreTool", { event: "PreTool", toolName: "Bash", input: { command: "rm -rf tmp" } });
    expect(results[0]?.blocking).toBe(true);
    expect(results[0]?.message).toBe("blocked");
  });
});
