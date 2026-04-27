/**
 * Wave 10 P0 / F1 — `/runbook ...` slash-command handler.
 * Renders runbook operations (list/show/match/apply/record).
 */

import {
  runbookAdd,
  runbookGet,
  runbookList,
  runbookMatch,
} from "../../agent/runbook/runbook-store.js";
import { runbookApply } from "../../agent/runbook/runbook-executor.js";
import type {
  RunbookApplyResult,
  RunbookMatch,
  RunbookRecord,
} from "../../agent/runbook/types.js";
import type { HandlerContext } from "./types.js";

export interface RunbookCommandData {
  command: string;
  id?: string;
  symptom?: string;
  pattern?: string;
  steps?: string[];
  tag?: string;
  dryRun?: boolean;
}

function formatRunbookRow(rec: RunbookRecord): string {
  const tags = rec.tags.length > 0 ? rec.tags.join(", ") : "-";
  return `| ${rec.id} | ${rec.confidence.toFixed(2)} | ${rec.usageCount} | ${rec.pattern.replace(/\|/g, "\\|")} | ${tags} |`;
}

function formatRunbookTable(records: RunbookRecord[]): string {
  if (records.length === 0) return "(no results)";
  const header = "| id | confidence | usage | pattern | tags |";
  const sep = "| --- | ---: | ---: | --- | --- |";
  return [header, sep, ...records.map(formatRunbookRow)].join("\n");
}

function formatRunbookDetail(rec: RunbookRecord): string {
  const lines: string[] = [];
  lines.push(`## Runbook ${rec.id}`);
  lines.push(`- pattern: ${rec.pattern}`);
  lines.push(`- confidence: ${rec.confidence.toFixed(2)}`);
  lines.push(`- usageCount: ${rec.usageCount}`);
  lines.push(`- tier: ${rec.tier}`);
  if (rec.tags.length > 0) lines.push(`- tags: ${rec.tags.join(", ")}`);
  if (rec.lastMatched) lines.push(`- lastMatched: ${rec.lastMatched}`);
  if (rec.cause) lines.push(`- cause: ${rec.cause}`);
  if (rec.evidenceCmd) lines.push(`- evidenceCmd: ${rec.evidenceCmd}`);
  if (rec.fixAction) lines.push(`- fixAction: ${rec.fixAction}`);
  if (rec.verification) lines.push(`- verification: ${rec.verification}`);

  lines.push("", "### Steps");
  if (rec.steps.length === 0) lines.push("(none)");
  else rec.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));

  if (rec.sourceIncidents.length > 0) {
    lines.push("", "### Source Incidents");
    for (const s of rec.sourceIncidents) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}

function formatMatchTable(matches: RunbookMatch[]): string {
  if (matches.length === 0) return "(no results)";
  const header = "| id | similarity | score | regex | pattern |";
  const sep = "| --- | ---: | ---: | --- | --- |";
  const rows = matches.map((m) =>
    `| ${m.runbook.id} | ${m.similarity.toFixed(3)} | ${m.score.toFixed(3)} | ${m.isRegexMatch ? "yes" : "no"} | ${m.runbook.pattern.replace(/\|/g, "\\|")} |`,
  );
  return [header, sep, ...rows].join("\n");
}

function formatApplyResult(result: RunbookApplyResult): string {
  const lines: string[] = [];
  lines.push(`## Runbook apply — ${result.runbookId}`);
  lines.push(`- dryRun: ${result.dryRun}`);
  lines.push(`- success: ${result.success}`);
  lines.push(`- stepsExecuted: ${result.stepsExecuted}`);
  if (result.verificationPassed !== undefined) {
    lines.push(`- verificationPassed: ${result.verificationPassed}`);
  }
  lines.push("", "### Step Results");
  result.stepResults.forEach((r, i) => {
    const out = r.output ? ` — ${r.output}` : "";
    lines.push(`${i + 1}. [${r.status}] ${r.step}${out}`);
  });
  return lines.join("\n");
}

export async function handleRunbookCommand(
  data: RunbookCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectId, rootDir } = context;
  const { command } = data;

  try {
    switch (command) {
      case "list": {
        let records = runbookList(projectId, rootDir);
        if (data.tag) {
          records = records.filter((rb) => rb.tags.includes(data.tag!));
        }
        return formatRunbookTable(records);
      }
      case "show": {
        if (!data.id) return "Error: runbook show requires id.";
        const rec = runbookGet(projectId, data.id, rootDir);
        if (!rec) return `Error: runbook not found: ${data.id}`;
        return formatRunbookDetail(rec);
      }
      case "match": {
        if (!data.symptom) return "Error: runbook match requires symptom.";
        const matches = runbookMatch(projectId, data.symptom, { touch: false }, rootDir);
        return `## Runbook match: ${data.symptom}\n\n${formatMatchTable(matches)}`;
      }
      case "apply": {
        if (!data.id) return "Error: runbook apply requires id.";
        const result = await runbookApply(projectId, data.id, { dryRun: data.dryRun !== false }, rootDir);
        return formatApplyResult(result);
      }
      case "record": {
        if (!data.pattern || !data.steps || data.steps.length === 0) {
          return "Error: runbook record requires pattern and steps.";
        }
        const id = runbookAdd(projectId, data.pattern, data.steps, undefined, rootDir);
        const rec = runbookGet(projectId, id, rootDir);
        return rec
          ? `Runbook recorded: ${id}\n\n${formatRunbookDetail(rec)}`
          : `Runbook recorded: ${id}`;
      }
      default:
        return `Error: unknown runbook command: ${command}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
