import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusTracker, formatAgentStatusLabel, readStatusSnapshot } from "../src/agent/status.js";

describe("Agent status tracker", () => {
  test("update/get/write round-trips a status snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-status-"));
    const statusPath = join(dir, "status.json");
    try {
      const tracker = new StatusTracker({
        statusPath,
        initial: { status: "idle", mode: "chat", provider: "mock", model: "m1" },
      });

      const observed: string[] = [];
      tracker.onStatusChange((snapshot) => observed.push(snapshot.status));
      const updated = tracker.update("running", { sessionId: "s1", turn: 2, message: "working" });

      expect(updated.status).toBe("running");
      expect(updated.sessionId).toBe("s1");
      expect(updated.turn).toBe(2);
      expect(observed).toEqual(["running"]);
      expect(existsSync(statusPath)).toBe(true);

      const read = readStatusSnapshot(statusPath);
      expect(read?.status).toBe("running");
      expect(read?.provider).toBe("mock");
      expect(read?.model).toBe("m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close preserves an exited final state instead of deleting status", () => {
    const dir = mkdtempSync(join(tmpdir(), "coreline-status-"));
    const statusPath = join(dir, "status.json");
    try {
      const tracker = new StatusTracker({ statusPath });
      tracker.close("exited", "done");
      const read = readStatusSnapshot(statusPath);
      expect(read?.status).toBe("exited");
      expect(read?.message).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formatAgentStatusLabel includes mode when available", () => {
    expect(formatAgentStatusLabel({ mode: "autopilot", status: "running" })).toBe("autopilot:running");
    expect(formatAgentStatusLabel({ status: "idle" })).toBe("idle");
    expect(formatAgentStatusLabel(null)).toBeNull();
  });
});
