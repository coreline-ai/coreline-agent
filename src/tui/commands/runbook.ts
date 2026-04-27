/**
 * Runbook slash sub-router — handles /runbook list|show|match|apply|record + /rca.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleRunbook(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd === "runbook") return handleRunbookCmd(args);
  if (cmd === "rca") return handleRca(args);
  return null;
}

function handleRunbookCmd(args: string[]): SlashCommandResult {
  const [subRaw, ...rbArgs] = args;
  const sub = subRaw?.toLowerCase();
  const tokens = rbArgs.filter((t) => t.length > 0);
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
    "Usage: /runbook list [--tag T] | /runbook show <id> | /runbook match <symptom> | " +
    "/runbook apply <id> [--dry-run] | /runbook record --pattern \"...\" --steps \"s1; s2\"";
  if (!sub) return { handled: true, output: usage };

  if (sub === "list") {
    return {
      handled: true,
      action: "runbook",
      data: { command: "list", tag: flags.get("--tag") },
    };
  }
  if (sub === "show") {
    const id = positional[0];
    if (!id) return { handled: true, output: "Usage: /runbook show <id>" };
    return { handled: true, action: "runbook", data: { command: "show", id } };
  }
  if (sub === "match") {
    const symptom = positional.join(" ").trim();
    if (!symptom) return { handled: true, output: "Usage: /runbook match <symptom>" };
    return { handled: true, action: "runbook", data: { command: "match", symptom } };
  }
  if (sub === "apply") {
    const id = positional[0];
    if (!id) return { handled: true, output: "Usage: /runbook apply <id> [--dry-run]" };
    const dryRun = tokens.includes("--dry-run");
    return {
      handled: true,
      action: "runbook",
      data: { command: "apply", id, dryRun },
    };
  }
  if (sub === "record") {
    const pattern = flags.get("--pattern");
    const stepsRaw = flags.get("--steps");
    if (!pattern || !stepsRaw) {
      return { handled: true, output: "Usage: /runbook record --pattern \"...\" --steps \"s1; s2; ...\"" };
    }
    const steps = stepsRaw.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    if (steps.length === 0) {
      return { handled: true, output: "Usage: /runbook record --pattern \"...\" --steps \"s1; s2; ...\"" };
    }
    return {
      handled: true,
      action: "runbook",
      data: { command: "record", pattern, steps },
    };
  }
  return { handled: true, output: usage };
}

function handleRca(args: string[]): SlashCommandResult {
  const tokens = args.filter((t) => t.length > 0);
  const positional = tokens.filter((t) => !t.startsWith("--"));
  const incidentId = positional[0];
  if (!incidentId) {
    return { handled: true, output: "Usage: /rca <incidentId> [--strategy heuristic]" };
  }
  const strategyIdx = tokens.indexOf("--strategy");
  const strategy = strategyIdx >= 0 ? tokens[strategyIdx + 1] : undefined;
  return {
    handled: true,
    action: "rca",
    data: { incidentId, strategy: strategy && !strategy.startsWith("--") ? strategy : undefined },
  };
}
