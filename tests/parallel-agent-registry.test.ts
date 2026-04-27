import { describe, expect, test } from "bun:test";
import { InMemoryParallelAgentTaskRegistry } from "../src/agent/parallel/task-registry.js";

describe("InMemoryParallelAgentTaskRegistry", () => {
  test("tracks deterministic transitions and terminal idempotency", () => {
    const registry = new InMemoryParallelAgentTaskRegistry({
      now: () => new Date("2026-04-20T10:00:00.000Z"),
      maxRetainedTerminalTasks: 5,
    });

    const created = registry.registerTask({
      prompt: "inspect repo",
      cwd: "/repo",
      provider: "local",
    });

    expect(created.status).toBe("pending");
    expect(created.id).toBe("parallel-task-0001");

    const running = registry.markRunning(created.id);
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBeDefined();

    const completed = registry.completeTask(created.id, {
      summary: "done",
      finalText: "final answer",
      usedTools: ["FileRead"],
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });

    expect(completed?.status).toBe("completed");
    expect(completed?.summary).toBe("done");
    expect(completed?.finalText).toBe("final answer");
    expect(completed?.usedTools).toEqual(["FileRead"]);

    const idempotent = registry.abortTask(created.id, "user");
    expect(idempotent?.status).toBe("completed");
    expect(registry.snapshot().completedCount).toBe(1);
    expect(registry.snapshot().abortedCount).toBe(0);
  });

  test("attaches runtime handles, cleans them up, and prunes terminal records", () => {
    const cleaned: string[] = [];
    const registry = new InMemoryParallelAgentTaskRegistry({
      now: () => new Date("2026-04-20T10:00:00.000Z"),
      maxRetainedTerminalTasks: 2,
    });

    const first = registry.registerTask({ prompt: "a", cwd: "/repo", provider: "local" });
    const second = registry.registerTask({ prompt: "b", cwd: "/repo", provider: "local" });
    const third = registry.registerTask({ prompt: "c", cwd: "/repo", provider: "local" });

    registry.attachRuntimeHandle(first.id, {
      id: first.id,
      abortController: new AbortController(),
      promise: Promise.resolve(),
      cleanup: () => cleaned.push(first.id),
    });

    registry.completeTask(first.id, { summary: "one" });
    registry.completeTask(second.id, { summary: "two" });
    registry.completeTask(third.id, { summary: "three" });

    registry.pruneTerminalTasks(2);

    expect(cleaned).toEqual([first.id]);
    expect(registry.getTask(first.id)).toBeUndefined();
    expect(registry.getTask(second.id)).toBeDefined();
    expect(registry.getTask(third.id)).toBeDefined();

    const snapshot = registry.snapshot();
    expect(snapshot.completedCount).toBe(2);
    expect(snapshot.tasks).toHaveLength(2);
  });

  test("progress updates and message appends refresh activity metadata", () => {
    const registry = new InMemoryParallelAgentTaskRegistry({
      now: () => new Date("2026-04-20T10:00:00.000Z"),
    });

    const task = registry.registerTask({ prompt: "progress", cwd: "/repo", provider: "local" });
    registry.updateProgress(task.id, { toolUseCount: 2, lastTool: "Glob", tokenCount: 5 });
    registry.appendMessageProgress(task.id, "hello world");

    const updated = registry.getTask(task.id);
    expect(updated?.progress?.toolUseCount).toBe(2);
    expect(updated?.progress?.lastTool).toBe("Glob");
    expect(updated?.progress?.messageCount).toBe(1);
    expect(updated?.progress?.tokenCount).toBe(5);
    expect(updated?.lastActivity).toBeDefined();
  });
});
