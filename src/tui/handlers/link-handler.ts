/**
 * Wave 10 P0 / F1 — `/link ...` slash-command handler.
 * Renders wiki-link forward index operations (scan/forward/graph/orphans).
 */

import {
  linkForward,
  linkGraph,
  linkOrphans,
  linkScan,
} from "../../memory/links.js";
import type { HandlerContext } from "./types.js";

export interface LinkCommandData {
  command: string;
  path?: string;
  source?: string;
  entity?: string;
  hops?: number;
}

export async function handleLinkCommand(
  data: LinkCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectMemory } = context;
  const { command } = data;

  try {
    switch (command) {
      case "scan": {
        const result = linkScan(projectMemory, data.path);
        const status = result.written ? "written" : `not written (${result.error ?? "unknown"})`;
        return `Link scan complete\n- filesScanned: ${result.filesScanned}\n- entitiesLinked: ${result.entitiesLinked}\n- index: ${status}`;
      }
      case "forward": {
        if (!data.source) return "Error: link forward requires source.";
        const targets = linkForward(projectMemory, data.source);
        if (targets.length === 0) return `(no results) — ${data.source} has no outbound links`;
        return `## Forward links from ${data.source}\n${targets.map((t) => `- ${t}`).join("\n")}`;
      }
      case "graph": {
        if (!data.entity) return "Error: link graph requires entity.";
        const graph = linkGraph(projectMemory, data.entity, { hops: data.hops });
        const nodesStr = graph.nodes.length > 0
          ? graph.nodes.map((n) => `- ${n}`).join("\n")
          : "(no nodes)";
        const edgesStr = graph.edges.length > 0
          ? graph.edges.map(([s, t]) => `- ${s} → ${t}`).join("\n")
          : "(no edges)";
        return [
          `## Link graph — root: ${graph.root} (hops: ${graph.hops})`,
          "",
          "### Nodes",
          nodesStr,
          "",
          "### Edges",
          edgesStr,
        ].join("\n");
      }
      case "orphans": {
        const orphans = linkOrphans(projectMemory);
        if (orphans.length === 0) return "(no results) — no orphan entities";
        return `## Orphan entities (${orphans.length})\n${orphans.map((o) => `- ${o}`).join("\n")}`;
      }
      default:
        return `Error: unknown link command: ${command}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
