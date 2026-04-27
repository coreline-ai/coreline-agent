import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusTracker } from "../src/agent/status.js";
import { createCorelineHookRuntime } from "../src/hooks/coreline-events.js";

describe("coreline hook events", () => {
  test("StatusTracker dispatches StatusChange hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-hooks-status-"));
    try {
      const runtime = createCorelineHookRuntime();
      const observed: string[] = [];
      runtime.engine.register({
        type: "function",
        event: "StatusChange",
        handler: (input) => {
          if ("status" in input && input.status) observed.push(input.status);
        },
      });
      const tracker = new StatusTracker({
        statusPath: join(dir, "status.json"),
        hookDispatcher: runtime.dispatchStatusChange,
      });
      tracker.update("running");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(observed).toEqual(["running"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hook failures do not fail status updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-hooks-status-"));
    try {
      const runtime = createCorelineHookRuntime();
      runtime.engine.register({
        type: "function",
        event: "StatusChange",
        handler: () => { throw new Error("observer failed"); },
      });
      const tracker = new StatusTracker({
        statusPath: join(dir, "status.json"),
        hookDispatcher: runtime.dispatchStatusChange,
      });
      const snapshot = tracker.update("running");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(snapshot.status).toBe("running");
      expect(tracker.get().status).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("StatusTracker works without a hook dispatcher", () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-hooks-status-"));
    try {
      const tracker = new StatusTracker({ statusPath: join(dir, "status.json") });
      expect(tracker.update("running").status).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
