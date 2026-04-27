import { describe, expect, test } from "bun:test";
import { handleSlashCommand } from "../src/tui/slash-commands.js";

describe("parallel agent slash commands", () => {
  test("help text includes parallel agent commands", () => {
    const result = handleSlashCommand("/help");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("/agents");
    expect(result.output).toContain("/agent list");
    expect(result.output).toContain("/agent status <id>");
    expect(result.output).toContain("/agent read <id>");
    expect(result.output).toContain("/agent stop <id>");
    expect(result.output).toContain("/agent resume <id>");
  });

  test("/agents routes to parallel agent list", () => {
    expect(handleSlashCommand("/agents")).toEqual({
      handled: true,
      action: "parallel_agent_list",
      data: { command: "list" },
    });
  });

  test("/agent list routes to parallel agent list", () => {
    expect(handleSlashCommand("/agent list")).toEqual({
      handled: true,
      action: "parallel_agent_list",
      data: { command: "list" },
    });
  });

  test("/agent status/read/stop/resume parse to distinct actions", () => {
    expect(handleSlashCommand("/agent status task-1")).toEqual({
      handled: true,
      action: "parallel_agent_status",
      data: { command: "status", id: "task-1" },
    });
    expect(handleSlashCommand("/agent read task-1")).toEqual({
      handled: true,
      action: "parallel_agent_read",
      data: { command: "read", id: "task-1" },
    });
    expect(handleSlashCommand("/agent stop task-1")).toEqual({
      handled: true,
      action: "parallel_agent_stop",
      data: { command: "stop", id: "task-1" },
    });
    expect(handleSlashCommand("/agent resume task-1")).toEqual({
      handled: true,
      action: "parallel_agent_resume",
      data: { command: "resume", id: "task-1" },
    });
  });

  test("usage errors are returned for missing or invalid agent arguments", () => {
    expect(handleSlashCommand("/agents extra")).toEqual({
      handled: true,
      output: "Usage: /agents",
    });
    expect(handleSlashCommand("/agent")).toEqual({
      handled: true,
      output: "Usage: /agent list|status <id>|read <id>|stop <id>|resume <id>",
    });
    expect(handleSlashCommand("/agent list extra")).toEqual({
      handled: true,
      output: "Usage: /agent list",
    });
    expect(handleSlashCommand("/agent status")).toEqual({
      handled: true,
      output: "Usage: /agent status <id>",
    });
    expect(handleSlashCommand("/agent read")).toEqual({
      handled: true,
      output: "Usage: /agent read <id>",
    });
    expect(handleSlashCommand("/agent stop")).toEqual({
      handled: true,
      output: "Usage: /agent stop <id>",
    });
    expect(handleSlashCommand("/agent resume")).toEqual({
      handled: true,
      output: "Usage: /agent resume <id>",
    });
  });
});
