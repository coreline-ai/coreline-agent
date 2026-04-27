import { describe, expect, test } from "bun:test";
import { handleSlashCommand } from "../src/tui/slash-commands.js";

describe("operator UX slash commands", () => {
  test("parses scaffold generation", () => {
    expect(handleSlashCommand("/scaffold tool MyTool")).toEqual({
      handled: true,
      action: "scaffold_generate",
      data: { kind: "tool", name: "MyTool" },
    });
    expect(handleSlashCommand("/scaffold").output).toContain("Usage: /scaffold");
  });

  test("parses runtime tweak commands", () => {
    expect(handleSlashCommand("/set")).toEqual({ handled: true, action: "runtime_show" });
    expect(handleSlashCommand("/set maxTurns 10")).toEqual({
      handled: true,
      action: "runtime_set",
      data: { key: "maxTurns", value: "10" },
    });
    expect(handleSlashCommand("/reset maxTurns")).toEqual({
      handled: true,
      action: "runtime_reset",
      data: { key: "maxTurns" },
    });
  });

  test("parses verify command targets", () => {
    expect(handleSlashCommand("/verify")).toEqual({
      handled: true,
      action: "verify_run",
      data: { target: "all" },
    });
    expect(handleSlashCommand("/verify test")).toEqual({
      handled: true,
      action: "verify_run",
      data: { target: "test" },
    });
    expect(handleSlashCommand("/verify lint").output).toContain("Usage: /verify");
  });
});
