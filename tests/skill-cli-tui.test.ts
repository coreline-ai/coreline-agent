import { describe, expect, test } from "bun:test";
import { handleSlashCommand } from "../src/tui/slash-commands.js";

describe("built-in skill slash commands", () => {
  test("routes skill list/show/use/auto/clear/status", () => {
    expect(handleSlashCommand("/skill list")).toEqual({ handled: true, action: "skill", data: { command: "list" } });
    expect(handleSlashCommand("/skill show dev-plan")).toEqual({ handled: true, action: "skill", data: { command: "show", value: "dev-plan" } });
    expect(handleSlashCommand("/skill use dev-plan,parallel-dev")).toEqual({ handled: true, action: "skill", data: { command: "use", value: "dev-plan,parallel-dev" } });
    expect(handleSlashCommand("/skill auto off")).toEqual({ handled: true, action: "skill", data: { command: "auto", value: "off" } });
    expect(handleSlashCommand("/skill clear")).toEqual({ handled: true, action: "skill", data: { command: "clear" } });
    expect(handleSlashCommand("/skill status")).toEqual({ handled: true, action: "skill", data: { command: "status" } });
  });

  test("routes context and macro helpers", () => {
    expect(handleSlashCommand("/context src/index.ts")).toEqual({ handled: true, action: "context", data: "src/index.ts" });
    expect(handleSlashCommand("/macro parse {\"id\":\"x\",\"name\":\"X\",\"steps\":[{\"prompt\":\"hi\"}]}")).toEqual({
      handled: true,
      action: "macro",
      data: { command: "parse", value: "{\"id\":\"x\",\"name\":\"X\",\"steps\":[{\"prompt\":\"hi\"}]}" },
    });
  });
});
