/**
 * Decision slash sub-router — handles /decision list|show|record|update + /evidence-first.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleDecision(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd === "decision") return handleDecisionCmd(args);
  if (cmd === "evidence-first") return handleEvidenceFirst(args);
  return null;
}

function handleDecisionCmd(args: string[]): SlashCommandResult {
  const [subRaw, ...decArgs] = args;
  const sub = subRaw?.toLowerCase();
  const tokens = decArgs.filter((t) => t.length > 0);
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
    "Usage: /decision list [--status S] [--tag T] | /decision show <id> | " +
    "/decision record --what \"...\" --why \"...\" --how \"...\" [--tags ...] | " +
    "/decision update <id> --outcome \"...\"";
  if (!sub) return { handled: true, output: usage };

  if (sub === "list") {
    return {
      handled: true,
      action: "decision",
      data: {
        command: "list",
        status: flags.get("--status"),
        tag: flags.get("--tag"),
      },
    };
  }
  if (sub === "show") {
    const id = positional[0];
    if (!id) return { handled: true, output: "Usage: /decision show <id>" };
    return { handled: true, action: "decision", data: { command: "show", id } };
  }
  if (sub === "record") {
    const what = flags.get("--what");
    const why = flags.get("--why");
    const how = flags.get("--how");
    if (!what || !why || !how) {
      return {
        handled: true,
        output: "Usage: /decision record --what \"...\" --why \"...\" --how \"...\" [--tags t1,t2]",
      };
    }
    const tagsRaw = flags.get("--tags");
    const tags = tagsRaw
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    return {
      handled: true,
      action: "decision",
      data: { command: "record", what, why, how, tags },
    };
  }
  if (sub === "update") {
    const id = positional[0];
    if (!id) return { handled: true, output: "Usage: /decision update <id> --outcome \"...\"" };
    return {
      handled: true,
      action: "decision",
      data: {
        command: "update",
        id,
        outcome: flags.get("--outcome"),
        status: flags.get("--status"),
      },
    };
  }
  return { handled: true, output: usage };
}

function handleEvidenceFirst(args: string[]): SlashCommandResult {
  const tokens = args.filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return { handled: true, output: "Usage: /evidence-first <query> [--limit N]" };
  }
  const limitIdx = tokens.indexOf("--limit");
  const limitRaw = limitIdx >= 0 && tokens[limitIdx + 1] ? Number(tokens[limitIdx + 1]) : undefined;
  const flagIdxs = new Set<number>();
  if (limitIdx >= 0) {
    flagIdxs.add(limitIdx);
    flagIdxs.add(limitIdx + 1);
  }
  const queryParts: string[] = [];
  tokens.forEach((t, i) => {
    if (!flagIdxs.has(i)) queryParts.push(t);
  });
  const query = queryParts.join(" ").trim();
  if (!query) {
    return { handled: true, output: "Usage: /evidence-first <query> [--limit N]" };
  }
  return {
    handled: true,
    action: "evidence_first",
    data: { query, limit: Number.isFinite(limitRaw) ? limitRaw : undefined },
  };
}
