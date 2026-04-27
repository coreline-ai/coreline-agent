/**
 * Prompt slash sub-router — handles /prompt save|list|use|delete|evidence|experiment.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handlePrompt(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd !== "prompt") return null;
  const [subcommandRaw, ...promptArgs] = args;
  const subcommand = subcommandRaw?.toLowerCase();
  const value = promptArgs.join(" ");
  if (subcommand === "save") {
    if (!value) return { handled: true, output: "Usage: /prompt save <name>" };
    return { handled: true, action: "prompt_save", data: value };
  }
  if (subcommand === "list" || subcommand === "ls") {
    return { handled: true, action: "prompt_list" };
  }
  if (subcommand === "use") {
    if (!value) return { handled: true, output: "Usage: /prompt use <name>" };
    return { handled: true, action: "prompt_use", data: value };
  }
  if (subcommand === "delete" || subcommand === "rm") {
    if (!value) return { handled: true, output: "Usage: /prompt delete <name>" };
    return { handled: true, action: "prompt_delete", data: value };
  }
  if (subcommand === "evidence") {
    const tokens = promptArgs.filter((t) => t.length > 0);
    const name = tokens.find((t) => !t.startsWith("--"));
    if (!name) return { handled: true, output: "Usage: /prompt evidence <name> [--days N]" };
    const daysIdx = tokens.indexOf("--days");
    const days = daysIdx >= 0 && tokens[daysIdx + 1] ? Number(tokens[daysIdx + 1]) : undefined;
    return {
      handled: true,
      action: "prompt_evidence",
      data: { name, days: Number.isFinite(days) ? days : undefined },
    };
  }
  if (subcommand === "experiment") {
    const tokens = promptArgs.filter((t) => t.length > 0);
    const name = tokens.find((t) => !t.startsWith("--"));
    if (!name) return { handled: true, output: "Usage: /prompt experiment <name> [--runs N]" };
    const runsIdx = tokens.indexOf("--runs");
    const runs = runsIdx >= 0 && tokens[runsIdx + 1] ? Number(tokens[runsIdx + 1]) : undefined;
    return {
      handled: true,
      action: "prompt_experiment",
      data: { name, runs: Number.isFinite(runs) ? runs : undefined },
    };
  }
  return {
    handled: true,
    output:
      "Usage: /prompt save <name> | /prompt list | /prompt use <name> | /prompt delete <name> | " +
      "/prompt evidence <name> [--days N] | /prompt experiment <name> [--runs N]",
  };
}
