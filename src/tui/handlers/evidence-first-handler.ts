/**
 * Wave 10 P0 / F1 — `/evidence-first <query>` slash-command handler.
 * Concurrent search across memory + incidents + decisions, ranked by score.
 */

import { evidenceFirst } from "../../agent/decision/evidence-first.js";
import type { HandlerContext } from "./types.js";

export interface EvidenceFirstCommandData {
  query: string;
  limit?: number;
}

export async function handleEvidenceFirstCommand(
  data: EvidenceFirstCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectId, rootDir } = context;

  try {
    if (!data.query || !data.query.trim()) {
      return "Error: evidence-first requires a query.";
    }

    const result = await evidenceFirst(projectId, data.query, {
      limit: data.limit,
      rootDir,
    });

    if (result.results.length === 0) {
      return `(no results) — query: ${data.query}\nelapsed: ${result.elapsedMs.toFixed(1)}ms`;
    }

    const header = "| source | id/session | title/summary | score |";
    const sep = "| --- | --- | --- | ---: |";
    const rows = result.results.map((hit) => {
      if (hit._source === "memory") {
        const sid = hit.sessionId ?? "-";
        const summary = (hit.summary ?? "").replace(/\|/g, "\\|").slice(0, 80);
        return `| memory | ${sid} | ${summary} | ${hit.score.toFixed(3)} |`;
      }
      if (hit._source === "incident") {
        const t = hit.title.replace(/\|/g, "\\|").slice(0, 80);
        return `| incident | ${hit.id} | ${t} (${hit.severity}/${hit.status}) | ${hit.score.toFixed(3)} |`;
      }
      // decision
      const t = hit.title.replace(/\|/g, "\\|").slice(0, 80);
      return `| decision | ${hit.id} | ${t} (${hit.status}) | ${hit.score.toFixed(3)} |`;
    });

    const counts = result.counts;
    return [
      `## Evidence-first: ${data.query}`,
      `_elapsed: ${result.elapsedMs.toFixed(1)}ms · memory:${counts.memory} incident:${counts.incident} decision:${counts.decision}_`,
      "",
      header,
      sep,
      ...rows,
    ].join("\n");
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
