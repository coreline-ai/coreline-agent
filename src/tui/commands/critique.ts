/**
 * /critique command parser — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 */

import type { SlashCommandResult } from "../slash-commands.js";

const USAGE =
  "Usage: /critique <file-path> [--philosophy NAME] [--strategy llm|heuristic]";

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

export function handleCritique(
  cmd: string,
  args: string[],
): SlashCommandResult | null {
  if (cmd !== "critique") return null;

  // First positional that doesn't start with "--" is the path.
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    return { handled: true, output: USAGE };
  }

  const philosophy = flagValue(args, "--philosophy");
  const strategyRaw = flagValue(args, "--strategy");
  let strategy: "llm" | "heuristic" | undefined;
  if (strategyRaw === "llm" || strategyRaw === "heuristic") {
    strategy = strategyRaw;
  } else if (strategyRaw !== undefined) {
    return {
      handled: true,
      output: `Invalid --strategy value: ${strategyRaw}. Expected llm|heuristic.`,
    };
  }

  return {
    handled: true,
    action: "critique",
    data: { path, philosophy, strategy },
  };
}
