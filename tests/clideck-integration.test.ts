import { describe, expect, test } from "bun:test";
import { buildArtifact, clideckResultToArtifact, statusToClideckEvent, statusToClideckState } from "../src/integrations/clideck/index.js";
import type { AgentStatusSnapshot } from "../src/agent/status.js";

const snapshot: AgentStatusSnapshot = {
  status: "running",
  mode: "autopilot",
  sessionId: "s1",
  provider: "mock",
  model: "m1",
  cwd: "/tmp/project",
  message: "working",
  lastActivity: "2026-04-19T00:00:00.000Z",
  pid: 1,
  startedAt: "2026-04-19T00:00:00.000Z",
  uptimeMs: 100,
};

describe("clideck adapter", () => {
  test("maps coreline status to clideck event", () => {
    const event = statusToClideckEvent(snapshot, () => new Date("2026-04-19T01:00:00.000Z"));

    expect(event.type).toBe("clideck_agent_event");
    expect(event.agent).toBe("coreline-agent");
    expect(event.state).toBe("working");
    expect(event.timestamp).toBe("2026-04-19T01:00:00.000Z");
    expect(event.sessionId).toBe("s1");
    expect(event.rawStatus?.mode).toBe("autopilot");
  });

  test("maps status values to clideck states", () => {
    expect(statusToClideckState("idle")).toBe("idle");
    expect(statusToClideckState("planning")).toBe("working");
    expect(statusToClideckState("blocked")).toBe("blocked");
    expect(statusToClideckState("needs_user")).toBe("waiting_user");
    expect(statusToClideckState("exited")).toBe("offline");
  });

  test("converts clideck result to coreline artifact", () => {
    const artifact = clideckResultToArtifact({
      taskId: "c1",
      status: "completed",
      summary: "done",
      artifacts: [
        { name: "report", kind: "text", content: "ok" },
        { name: "log", kind: "file", path: "/tmp/log.txt" },
      ],
      metadata: { source: "clideck" },
    });

    expect(artifact?.type).toBe("coreline_artifact");
    expect(artifact?.source).toBe("clideck");
    expect(artifact?.content).toContain("done");
    expect(artifact?.content).toContain("[text] report: ok");
    expect(artifact?.content).toContain("[file] log: /tmp/log.txt");
  });

  test("rejects invalid clideck result payload", () => {
    expect(clideckResultToArtifact({ taskId: "x", status: "unknown" })).toBeNull();
    expect(buildArtifact({ taskId: "x", status: "failed" }).content).toContain("failed");
  });
});
