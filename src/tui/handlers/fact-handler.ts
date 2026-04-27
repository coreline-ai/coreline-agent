/**
 * Wave 10 P0 / F1 — `/fact ...` slash-command handler.
 * Renders fact bitemporal queries (add/at/history/invalidate/list/keys) as
 * markdown for display in the REPL.
 */

import {
  factAdd,
  factAt,
  factHistory,
  factInvalidate,
  factKeys,
  factList,
} from "../../memory/facts.js";
import type { FactRecord } from "../../memory/facts-types.js";
import type { HandlerContext } from "./types.js";

export interface FactCommandData {
  command: string;
  entity?: string;
  key?: string;
  value?: string;
  validFrom?: string;
  validTo?: string;
  asOf?: string;
  invalidAt?: string;
}

function tableRow(values: (string | undefined)[]): string {
  return `| ${values.map((v) => (v && v.length > 0 ? v : "(open)")).join(" | ")} |`;
}

function factsTable(records: FactRecord[]): string {
  if (records.length === 0) return "(no results)";
  const header = "| key | value | validFrom | validTo | recordedAt |";
  const sep = "| --- | --- | --- | --- | --- |";
  const rows = records.map((f) =>
    tableRow([f.key, f.value, f.validFrom, f.validTo, f.recordedAt]),
  );
  return [header, sep, ...rows].join("\n");
}

export async function handleFactCommand(
  data: FactCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectMemory } = context;
  const { command } = data;

  try {
    switch (command) {
      case "add": {
        if (!data.entity || !data.key || data.value === undefined) {
          return "Error: fact add requires entity, key, value.";
        }
        const result = factAdd(projectMemory, data.entity, data.key, data.value, {
          validFrom: data.validFrom,
          validTo: data.validTo,
        });
        if (!result.written) {
          return `Error: ${result.error ?? "fact write failed"}`;
        }
        return `Fact added: ${data.entity}.${data.key} = ${data.value}\nFile: ${result.filePath}`;
      }
      case "at": {
        if (!data.entity || !data.key) {
          return "Error: fact at requires entity, key.";
        }
        const fact = factAt(projectMemory, data.entity, data.key, { asOf: data.asOf });
        if (!fact) {
          return `(no results) — no fact for ${data.entity}.${data.key}${
            data.asOf ? ` at ${data.asOf}` : ""
          }`;
        }
        return factsTable([fact]);
      }
      case "history": {
        if (!data.entity) return "Error: fact history requires entity.";
        const records = factHistory(projectMemory, data.entity, data.key);
        return factsTable(records);
      }
      case "invalidate": {
        if (!data.entity || !data.key) {
          return "Error: fact invalidate requires entity, key.";
        }
        const closed = factInvalidate(projectMemory, data.entity, data.key, {
          invalidAt: data.invalidAt,
        });
        return `Closed ${closed} open interval(s) for ${data.entity}.${data.key}.`;
      }
      case "list": {
        if (!data.entity) return "Error: fact list requires entity.";
        const records = factList(projectMemory, data.entity);
        return factsTable(records);
      }
      case "keys": {
        if (!data.entity) return "Error: fact keys requires entity.";
        const keys = factKeys(projectMemory, data.entity);
        if (keys.length === 0) return "(no results)";
        return `## Keys for ${data.entity}\n${keys.map((k) => `- ${k}`).join("\n")}`;
      }
      default:
        return `Error: unknown fact command: ${command}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
