/**
 * Incident slash sub-router — handles /incident list|show|update|confirm|resolve.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleIncident(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd !== "incident") return null;
  const [subRaw, ...incArgs] = args;
  const sub = subRaw?.toLowerCase();
  const tokens = incArgs.filter((t) => t.length > 0);
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(t, next);
        i += 1;
      } else {
        flags.set(t, "");
      }
    } else {
      positional.push(t);
    }
  }
  const usage =
    "Usage: /incident list [--severity S] [--status S] | /incident show <id> | /incident update <id> ... | " +
    "/incident confirm <id> <hypothesis> | /incident resolve <id> --resolution \"...\"";
  if (!sub) return { handled: true, output: usage };

  if (sub === "list") {
    return {
      handled: true,
      action: "incident",
      data: {
        command: "list",
        severity: flags.get("--severity"),
        status: flags.get("--status"),
      },
    };
  }
  if (sub === "show") {
    const id = positional[0];
    if (!id) return { handled: true, output: "Usage: /incident show <id>" };
    return { handled: true, action: "incident", data: { command: "show", id } };
  }
  if (sub === "update") {
    const id = positional[0];
    if (!id) return { handled: true, output: "Usage: /incident update <id> [flags]" };
    return {
      handled: true,
      action: "incident",
      data: {
        command: "update",
        id,
        addHypothesis: flags.get("--hypothesis"),
        confirmHypothesis: flags.get("--confirm"),
        rejectHypothesis: flags.get("--reject"),
        addEvidence: flags.get("--evidence"),
        severity: flags.get("--severity"),
      },
    };
  }
  if (sub === "confirm") {
    const id = positional[0];
    const hypothesis = positional.slice(1).join(" ").trim();
    if (!id || !hypothesis) {
      return { handled: true, output: "Usage: /incident confirm <id> <hypothesis>" };
    }
    return {
      handled: true,
      action: "incident",
      data: { command: "confirm", id, hypothesis },
    };
  }
  if (sub === "resolve") {
    const id = positional[0];
    const resolution = flags.get("--resolution");
    if (!id || !resolution) {
      return { handled: true, output: "Usage: /incident resolve <id> --resolution \"...\"" };
    }
    return {
      handled: true,
      action: "incident",
      data: { command: "resolve", id, resolution },
    };
  }
  return { handled: true, output: usage };
}
