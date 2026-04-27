/**
 * Search-precise slash sub-router — handles /search-precise <query> [--top-k N] [--threshold N].
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleSearchPrecise(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd !== "search-precise") return null;
  const tokens = args.filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return { handled: true, output: "Usage: /search-precise <query> [--top-k N] [--threshold N]" };
  }
  const flagIdxs = new Set<number>();
  tokens.forEach((t, i) => {
    if (t === "--top-k" || t === "--threshold") {
      flagIdxs.add(i);
      flagIdxs.add(i + 1);
    }
  });
  const queryParts: string[] = [];
  tokens.forEach((t, i) => {
    if (!flagIdxs.has(i)) queryParts.push(t);
  });
  const query = queryParts.join(" ").trim();
  if (!query) {
    return { handled: true, output: "Usage: /search-precise <query> [--top-k N] [--threshold N]" };
  }
  const topKIdx = tokens.indexOf("--top-k");
  const thIdx = tokens.indexOf("--threshold");
  const topKRaw = topKIdx >= 0 && tokens[topKIdx + 1] ? Number(tokens[topKIdx + 1]) : undefined;
  const thRaw = thIdx >= 0 && tokens[thIdx + 1] ? Number(tokens[thIdx + 1]) : undefined;
  return {
    handled: true,
    action: "search_precise",
    data: {
      query,
      topK: Number.isFinite(topKRaw) ? topKRaw : undefined,
      threshold: Number.isFinite(thRaw) ? thRaw : undefined,
    },
  };
}
