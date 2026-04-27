/**
 * Wave 10 P0 / F1 — `/rca <incidentId>` slash-command handler.
 * Renders the heuristic RCA report (hypotheses, runbook suggestions,
 * related incidents).
 */

import { computeRCA } from "../../agent/rca/rca-engine.js";
import type { RCAOptions } from "../../agent/rca/types.js";
import type { HandlerContext } from "./types.js";

export interface RcaCommandData {
  incidentId: string;
  strategy?: string;
}

export async function handleRcaCommand(
  data: RcaCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectId, rootDir } = context;

  try {
    if (!data.incidentId) return "Error: rca requires incidentId.";

    const opts: RCAOptions = {};
    if (data.strategy === "heuristic" || data.strategy === "llm") {
      opts.strategy = data.strategy;
    }

    const report = await computeRCA(projectId, data.incidentId, opts, rootDir);

    const lines: string[] = [];
    lines.push(`## RCA Report — ${report.incidentId} (${report.strategy})`);
    lines.push(
      `_severity: ${report.severity} · status: ${report.status} · symptoms: ${report.symptomCount} · evidence: ${report.evidenceCount}_`,
    );

    lines.push("", "### Hypotheses (sorted by score)");
    if (report.hypotheses.length === 0) {
      lines.push("(none)");
    } else {
      report.hypotheses.forEach((h, i) => {
        lines.push(`${i + 1}. [${h.status}] ${h.text} — score: ${h.score.toFixed(3)}`);
      });
    }

    lines.push("", "### Suggested Runbooks");
    if (report.suggestedRunbooks.length === 0) {
      lines.push("(none)");
    } else {
      for (const m of report.suggestedRunbooks) {
        const tag = m.isRegexMatch ? " [regex]" : "";
        lines.push(
          `- ${m.runbook.id} "${m.runbook.pattern}"${tag} — similarity: ${m.similarity.toFixed(3)}, score: ${m.score.toFixed(3)}`,
        );
      }
    }

    lines.push("", "### Related Incidents");
    if (report.relatedIncidents.length === 0) {
      lines.push("(none)");
    } else {
      for (const r of report.relatedIncidents) {
        lines.push(
          `- ${r.incidentId} "${r.title}" (${r.severity}/${r.status}) — similarity: ${r.similarity.toFixed(3)}`,
        );
      }
    }

    return lines.join("\n");
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
