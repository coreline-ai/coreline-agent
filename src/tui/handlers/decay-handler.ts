/**
 * Wave 10 P0 / F1 — `/memory decay-*` slash-command handler.
 * Renders reversible-decay/tombstone operations as markdown for the REPL.
 */

import {
  decayApply,
  decayIsTombstoned,
  decayList,
  decayRestore,
  decayRun,
  decayTombstone,
} from "../../memory/decay.js";
import type { DecayState } from "../../memory/decay-types.js";
import type { HandlerContext } from "./types.js";

export interface DecayCommandData {
  command: string;
  name?: string;
  rate?: number;
  below?: number;
  includeTombstoned?: boolean;
  olderThanDays?: number;
  accessCountLt?: number;
  weightGt?: number;
}

function decayRow(state: DecayState): string {
  return `| ${state.name} | ${state.decayWeight.toFixed(6)} | ${state.decayCount} | ${state.lastAccessed ?? "-"} | ${state.tombstoned ? "yes" : "no"} |`;
}

function decayTable(states: DecayState[]): string {
  if (states.length === 0) return "(no results)";
  const header = "| name | weight | count | lastAccessed | tombstoned |";
  const sep = "| --- | ---: | ---: | --- | --- |";
  return [header, sep, ...states.map(decayRow)].join("\n");
}

export async function handleDecayCommand(
  data: DecayCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectMemory } = context;
  const { command } = data;

  try {
    switch (command) {
      case "apply": {
        if (!data.name) return "Error: decay apply requires name.";
        const state = decayApply(projectMemory, data.name, { decayRate: data.rate });
        return `Decay applied to ${state.name}\n${decayTable([state])}`;
      }
      case "list": {
        const states = decayList(projectMemory, {
          belowThreshold: data.below,
          includeTombstoned: data.includeTombstoned,
        });
        return decayTable(states);
      }
      case "restore": {
        if (!data.name) return "Error: decay restore requires name.";
        const state = decayRestore(projectMemory, data.name);
        return `Restored ${state.name}\n${decayTable([state])}`;
      }
      case "run": {
        const result = decayRun(
          projectMemory,
          {
            olderThanDays: data.olderThanDays,
            accessCountLt: data.accessCountLt,
            weightGt: data.weightGt,
          },
          data.rate ?? 0.1,
        );
        const errPart = result.errors && result.errors.length > 0
          ? `\n\nErrors:\n${result.errors.map((e) => `- ${e.name}: ${e.error}`).join("\n")}`
          : "";
        return `Decay run: ${result.applied} entries decayed.\n${decayTable(result.states)}${errPart}`;
      }
      case "tombstone": {
        if (!data.name) return "Error: decay tombstone requires name.";
        const state = decayTombstone(projectMemory, data.name);
        return `Tombstoned ${state.name}\n${decayTable([state])}`;
      }
      case "isTombstoned": {
        if (!data.name) return "Error: decay isTombstoned requires name.";
        const tomb = decayIsTombstoned(projectMemory, data.name);
        return `${data.name}: ${tomb ? "tombstoned" : "live"}`;
      }
      default:
        return `Error: unknown decay command: ${command}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
