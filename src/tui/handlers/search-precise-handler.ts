/**
 * Wave 10 P0 / F1 — `/search-precise <query>` slash-command handler.
 * Runs the exact-substring-first / fuzzy-fallback memory search and renders
 * matched entries in a markdown table.
 */

import { searchPrecise } from "../../memory/chunking.js";
import type { HandlerContext } from "./types.js";

export interface SearchPreciseCommandData {
  query: string;
  topK?: number;
  threshold?: number;
}

export async function handleSearchPreciseCommand(
  data: SearchPreciseCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectMemory } = context;

  try {
    if (!data.query || !data.query.trim()) {
      return "Error: search-precise requires a query.";
    }
    const result = searchPrecise(projectMemory, data.query, {
      topK: data.topK,
      scoreThreshold: data.threshold,
    });

    if (result.results.length === 0) {
      return `(no results) — query: ${data.query}${result.fallbackUsed ? " (fallback used)" : ""}`;
    }

    const header = "| name | type | tier | description |";
    const sep = "| --- | --- | --- | --- |";
    const rows = result.results.map((entry) => {
      const desc = entry.description ? entry.description.replace(/\|/g, "\\|").slice(0, 80) : "-";
      return `| ${entry.name} | ${entry.type} | ${entry.tier ?? "recall"} | ${desc} |`;
    });
    const fallback = result.fallbackUsed ? "\n\n(fallback fuzzy search used)" : "";
    return [
      `## Search: ${data.query} — ${result.results.length} hit(s)`,
      "",
      header,
      sep,
      ...rows,
    ].join("\n") + fallback;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
