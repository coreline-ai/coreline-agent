/**
 * Wave 10 P0 / F1 — `/incident ...` slash-command handler.
 * Renders incident layer queries (list/show/update/confirm/resolve).
 */

import {
  incidentGet,
  incidentRecord,
  incidentSearch,
  incidentUpdate,
} from "../../agent/incident/incident-store.js";
import type {
  IncidentRecord,
  IncidentSeverity,
  IncidentStatus,
} from "../../agent/incident/types.js";
import type { HandlerContext } from "./types.js";

export interface IncidentCommandData {
  command: string;
  id?: string;
  severity?: string;
  status?: string;
  hypothesis?: string;
  addHypothesis?: string;
  confirmHypothesis?: string;
  rejectHypothesis?: string;
  addEvidence?: string;
  resolution?: string;
}

function formatIncidentRow(rec: IncidentRecord): string {
  return `| ${rec.id} | ${rec.severity} | ${rec.status} | ${rec.title.replace(/\|/g, "\\|")} | ${rec.detectedAt} |`;
}

function formatIncidentTable(records: IncidentRecord[]): string {
  if (records.length === 0) return "(no results)";
  const header = "| id | severity | status | title | detectedAt |";
  const sep = "| --- | --- | --- | --- | --- |";
  return [header, sep, ...records.map(formatIncidentRow)].join("\n");
}

function formatIncidentDetail(rec: IncidentRecord): string {
  const lines: string[] = [];
  lines.push(`## Incident ${rec.id}`);
  lines.push(`- title: ${rec.title}`);
  lines.push(`- severity: ${rec.severity}`);
  lines.push(`- status: ${rec.status}`);
  lines.push(`- detectedAt: ${rec.detectedAt}`);
  if (rec.resolvedAt) lines.push(`- resolvedAt: ${rec.resolvedAt}`);
  lines.push(`- tier: ${rec.tier}`);
  if (rec.tags.length > 0) lines.push(`- tags: ${rec.tags.join(", ")}`);
  if (rec.affected.length > 0) lines.push(`- affected: ${rec.affected.join(", ")}`);

  lines.push("", "### Symptoms");
  if (rec.symptoms.length === 0) lines.push("(none)");
  else for (const s of rec.symptoms) lines.push(`- ${s}`);

  lines.push("", "### Evidence");
  if (rec.evidence.length === 0) lines.push("(none)");
  else for (const e of rec.evidence) {
    const ts = e.collectedAt ? ` (${e.collectedAt})` : "";
    lines.push(`- [${e.type}]${ts} ${e.value}`);
  }

  lines.push("", "### Hypotheses");
  if (rec.hypotheses.length === 0) lines.push("(none)");
  else for (const h of rec.hypotheses) {
    const ts = h.notedAt ? ` @ ${h.notedAt}` : "";
    lines.push(`- [${h.status}${ts}] ${h.text}`);
  }

  lines.push("", "### Resolution");
  lines.push(rec.resolution ?? "(pending)");

  if (rec.related.length > 0) {
    lines.push("", "### Related");
    for (const r of rec.related) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

export async function handleIncidentCommand(
  data: IncidentCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectId, rootDir } = context;
  const { command } = data;

  try {
    switch (command) {
      case "list": {
        const records = incidentSearch(
          projectId,
          {
            severity: data.severity as IncidentSeverity | undefined,
            status: data.status as IncidentStatus | undefined,
          },
          rootDir,
        );
        return formatIncidentTable(records);
      }
      case "show": {
        if (!data.id) return "Error: incident show requires id.";
        const rec = incidentGet(projectId, data.id, rootDir);
        if (!rec) return `Error: incident not found: ${data.id}`;
        return formatIncidentDetail(rec);
      }
      case "update": {
        if (!data.id) return "Error: incident update requires id.";
        const rec = incidentUpdate(
          projectId,
          data.id,
          {
            severity: data.severity as IncidentSeverity | undefined,
            addHypothesis: data.addHypothesis ? [data.addHypothesis] : undefined,
            confirmHypothesis: data.confirmHypothesis ? [data.confirmHypothesis] : undefined,
            rejectHypothesis: data.rejectHypothesis ? [data.rejectHypothesis] : undefined,
            addEvidence: data.addEvidence
              ? [{ type: "note", value: data.addEvidence, collectedAt: new Date().toISOString() }]
              : undefined,
          },
          rootDir,
        );
        return `Incident ${rec.id} updated.\n\n${formatIncidentDetail(rec)}`;
      }
      case "confirm": {
        if (!data.id || !data.hypothesis) {
          return "Error: incident confirm requires id and hypothesis.";
        }
        const rec = incidentUpdate(
          projectId,
          data.id,
          { confirmHypothesis: [data.hypothesis] },
          rootDir,
        );
        return `Hypothesis confirmed for ${rec.id}: ${data.hypothesis}`;
      }
      case "resolve": {
        if (!data.id || !data.resolution) {
          return "Error: incident resolve requires id and resolution.";
        }
        const rec = incidentUpdate(
          projectId,
          data.id,
          { resolution: data.resolution, resolved: true },
          rootDir,
        );
        return `Incident ${rec.id} resolved.\n\n${formatIncidentDetail(rec)}`;
      }
      default:
        return `Error: unknown incident command: ${command}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// Re-export for convenience in tests
export { incidentRecord };
