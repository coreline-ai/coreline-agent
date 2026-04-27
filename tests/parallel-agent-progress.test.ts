import { describe, expect, test } from "bun:test";
import { InMemoryParallelAgentTaskRegistry } from "../src/agent/parallel/task-registry.js";
import { createParallelAgentProgressSink } from "../src/agent/parallel/progress.js";

describe("parallel agent progress sink", () => {
  test("updates message, tool, and token progress on the registry", () => {
    const registry = new InMemoryParallelAgentTaskRegistry({
      now: () => new Date("2026-04-20T11:00:00.000Z"),
    });
    const task = registry.registerTask({ prompt: "track", cwd: "/repo", provider: "local" });
    const sink = createParallelAgentProgressSink(registry, task.id, {
      now: () => new Date("2026-04-20T11:00:01.000Z"),
    });

    sink.onMessage?.(task.id, "first message");
    sink.onToolStart?.(task.id, "FileRead");
    sink.onToolEnd?.(task.id, "FileRead", true);
    sink.onUsage?.(task.id, { inputTokens: 10, outputTokens: 7 });
    sink.onUsage?.(task.id, { inputTokens: 1, outputTokens: 2 });

    const updated = registry.getTask(task.id);
    expect(updated?.progress?.messageCount).toBe(1);
    expect(updated?.progress?.toolUseCount).toBe(1);
    expect(updated?.progress?.lastTool).toBe("FileRead");
    expect(updated?.progress?.tokenCount).toBe(20);
    expect(updated?.lastActivity).toBeDefined();
  });

  test("progress helper can be layered with direct registry updates", () => {
    const registry = new InMemoryParallelAgentTaskRegistry();
    const task = registry.registerTask({ prompt: "layer", cwd: "/repo", provider: "local" });
    const sink = createParallelAgentProgressSink(registry, task.id);

    sink.onToolStart?.(task.id, "Glob");
    registry.updateProgress(task.id, { lastTool: "Grep" });
    sink.onToolEnd?.(task.id, "Glob", false);

    const updated = registry.getTask(task.id);
    expect(updated?.progress?.toolUseCount).toBe(1);
    expect(updated?.progress?.lastTool).toBe("Glob");
  });
});
