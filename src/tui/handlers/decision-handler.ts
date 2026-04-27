/**
 * Wave 10 P0 / F1 — `/decision ...` slash-command handler.
 * Renders What/Why/How decision records (list/show/record/update).
 */

import {
  decisionGet,
  decisionRecord,
  decisionSearch,
  decisionUpdate,
} from "../../agent/decision/decision-store.js";
import type {
  DecisionRecord,
  DecisionStatus,
} from "../../agent/decision/types.js";
import type { HandlerContext } from "./types.js";

export interface DecisionCommandData {
  command: string;
  id?: string;
  status?: string;
  tag?: string;
  what?: string;
  why?: string;
  how?: string;
  tags?: string[];
  outcome?: string;
}

function formatDecisionRow(rec: DecisionRecord): string {
  return `| ${rec.id} | ${rec.status} | ${rec.title.replace(/\|/g, "\\|")} | ${rec.decidedAt} |`;
}

function formatDecisionTable(records: DecisionRecord[]): string {
  if (records.length === 0) return "(no results)";
  const header = "| id | status | title | decidedAt |";
  const sep = "| --- | --- | --- | --- |";
  return [header, sep, ...records.map(formatDecisionRow)].join("\n");
}

function formatDecisionDetail(rec: DecisionRecord): string {
  const lines: string[] = [];
  lines.push(`## Decision ${rec.id}`);
  lines.push(`- title: ${rec.title}`);
  lines.push(`- status: ${rec.status}`);
  lines.push(`- decidedAt: ${rec.decidedAt}`);
  lines.push(`- tier: ${rec.tier}`);
  if (rec.tags.length > 0) lines.push(`- tags: ${rec.tags.join(", ")}`);
  if (rec.linkedIncidents.length > 0) {
    lines.push(`- linkedIncidents: ${rec.linkedIncidents.join(", ")}`);
  }

  lines.push("", "### What", rec.what);
  lines.push("", "### Why", rec.why);
  lines.push("", "### How", rec.how);
  lines.push("", "### Outcome", rec.outcome ?? "(pending)");
  return lines.join("\n");
}

export async function handleDecisionCommand(
  data: DecisionCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectId, rootDir } = context;
  const { command } = data;

  try {
    switch (command) {
      case "list": {
        const records = decisionSearch(
          projectId,
          {
            status: data.status as DecisionStatus | undefined,
            tag: data.tag,
          },
          rootDir,
        );
        return formatDecisionTable(records);
      }
      case "show": {
        if (!data.id) return "Error: decision show requires id.";
        const rec = decisionGet(projectId, data.id, rootDir);
        if (!rec) return `Error: decision not found: ${data.id}`;
        return formatDecisionDetail(rec);
      }
      case "record": {
        if (!data.what || !data.why || !data.how) {
          return "Error: decision record requires what, why, how.";
        }
        const id = decisionRecord(
          projectId,
          data.what,
          data.why,
          data.how,
          { tags: data.tags },
          rootDir,
        );
        const rec = decisionGet(projectId, id, rootDir);
        return rec
          ? `Decision recorded: ${id}\n\n${formatDecisionDetail(rec)}`
          : `Decision recorded: ${id}`;
      }
      case "update": {
        if (!data.id) return "Error: decision update requires id.";
        const rec = decisionUpdate(
          projectId,
          data.id,
          {
            outcome: data.outcome,
            status: data.status as DecisionStatus | undefined,
          },
          rootDir,
        );
        return `Decision ${rec.id} updated.\n\n${formatDecisionDetail(rec)}`;
      }
      default:
        return `Error: unknown decision command: ${command}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
