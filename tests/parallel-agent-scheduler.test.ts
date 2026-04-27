import { afterAll, describe, expect, test } from "bun:test";
import { ParallelAgentScheduler } from "../src/agent/parallel/scheduler.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ParallelAgentScheduler", () => {
  test("limits concurrency and drains pending work in FIFO order", async () => {
    const scheduler = new ParallelAgentScheduler({
      maxParallelAgentTasks: 2,
      maxRetainedTerminalTasks: 10,
    });

    const started: string[] = [];
    const finished: string[] = [];
    let active = 0;
    let maxSeen = 0;

    const tasks = ["one", "two", "three", "four"].map((name) =>
      scheduler.submit({ prompt: name, cwd: "/repo", provider: "local" }, async (task) => {
        started.push(task.id);
        active += 1;
        maxSeen = Math.max(maxSeen, active);
        await sleep(20);
        active -= 1;
        finished.push(task.id);
        return { summary: task.prompt, finalText: task.prompt, usedTools: ["FileRead"] };
      }),
    );

    const results = await Promise.all(tasks);

    expect(results.map((task) => task.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(started).toEqual(["parallel-task-0001", "parallel-task-0002", "parallel-task-0003", "parallel-task-0004"]);
    expect(finished).toEqual(["parallel-task-0001", "parallel-task-0002", "parallel-task-0003", "parallel-task-0004"]);
    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(scheduler.snapshot().completedCount).toBe(4);
  });

  test("stop aborts queued tasks and active tasks cleanly", async () => {
    const scheduler = new ParallelAgentScheduler({
      maxParallelAgentTasks: 1,
      maxRetainedTerminalTasks: 10,
    });

    const started: string[] = [];
    const first = scheduler.submit({ prompt: "hold", cwd: "/repo", provider: "local" }, async (task, handle) => {
      started.push(task.id);
      await sleep(30);
      if (handle.abortController.signal.aborted) {
        return { summary: "stopped", finalText: "stopped" };
      }
      return { summary: "done", finalText: "done" };
    });

    const second = scheduler.submit({ prompt: "queued", cwd: "/repo", provider: "local" }, async () => ({ summary: "never" }));
    scheduler.stop("parallel-task-0002", "user");

    const firstResult = await first;
    const secondResult = await second;

    expect(started).toEqual(["parallel-task-0001"]);
    expect(firstResult.status).toBe("completed");
    expect(secondResult.status).toBe("aborted");
    expect(scheduler.snapshot().abortedCount).toBe(1);
  });

  test("waitForIdle resolves after running and queued tasks finish", async () => {
    const scheduler = new ParallelAgentScheduler({
      maxParallelAgentTasks: 2,
      maxRetainedTerminalTasks: 10,
    });

    const result = await Promise.all([
      scheduler.submit({ prompt: "alpha", cwd: "/repo", provider: "local" }, async () => {
        await sleep(10);
        return { summary: "alpha", finalText: "alpha" };
      }),
      scheduler.submit({ prompt: "beta", cwd: "/repo", provider: "local" }, async () => {
        await sleep(10);
        return { summary: "beta", finalText: "beta" };
      }),
      scheduler.submit({ prompt: "gamma", cwd: "/repo", provider: "local" }, async () => {
        await sleep(10);
        return { summary: "gamma", finalText: "gamma" };
      }),
    ]);

    await scheduler.waitForIdle();
    expect(result).toHaveLength(3);
    expect(scheduler.snapshot().pendingCount).toBe(0);
    expect(scheduler.snapshot().runningCount).toBe(0);
    expect(scheduler.snapshot().completedCount).toBe(3);
  });
});
