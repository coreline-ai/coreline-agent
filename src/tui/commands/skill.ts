/**
 * Skill slash sub-router — handles /skill list|show|use|clear|auto|status|stats + /subagent stats.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleSkill(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd === "skill") return handleSkillCmd(args);
  if (cmd === "subagent") return handleSubagent(args);
  return null;
}

function handleSkillCmd(args: string[]): SlashCommandResult {
  const [subcommandRaw, ...skillArgs] = args;
  const subcommand = subcommandRaw?.toLowerCase();
  const value = skillArgs.join(" ");
  if (!subcommand || subcommand === "status") {
    return { handled: true, action: "skill", data: { command: "status" } };
  }
  if (subcommand === "list" || subcommand === "ls") {
    return { handled: true, action: "skill", data: { command: "list" } };
  }
  if (subcommand === "show") {
    if (!value) return { handled: true, output: "Usage: /skill show <id>" };
    return { handled: true, action: "skill", data: { command: "show", value } };
  }
  if (subcommand === "use") {
    if (!value) return { handled: true, output: "Usage: /skill use <id[,id...]>" };
    return { handled: true, action: "skill", data: { command: "use", value } };
  }
  if (subcommand === "clear") {
    return { handled: true, action: "skill", data: { command: "clear" } };
  }
  if (subcommand === "auto") {
    const mode = value.trim().toLowerCase();
    if (mode !== "on" && mode !== "off") return { handled: true, output: "Usage: /skill auto on|off" };
    return { handled: true, action: "skill", data: { command: "auto", value: mode } };
  }
  if (subcommand === "stats") {
    return { handled: true, action: "skill", data: { command: "stats", value: value.trim() || undefined } };
  }
  return { handled: true, output: "Usage: /skill list|show <id>|use <id[,id...]>|clear|auto on|off|status|stats [id]" };
}

function handleSubagent(args: string[]): SlashCommandResult {
  const [sub, ...subArgs] = args;
  if (sub === "stats") {
    const value = subArgs.join(" ").trim();
    return { handled: true, action: "subagent_stats", data: { value: value || undefined } };
  }
  return { handled: true, output: "Usage: /subagent stats [type]" };
}
