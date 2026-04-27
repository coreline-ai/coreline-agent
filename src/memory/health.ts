/**
 * Memory health diagnostic — Wave 10 P3 O3.
 *
 * Aggregates Wave 1-9 memory state into a single report:
 * tier distribution, decay distribution, tombstone count, incident/decision/runbook counts,
 * orphan links + recommendations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectMemoryCore } from "./types.js";
import { tierList } from "./tiering.js";
import { linkOrphans } from "./links.js";
import {
  getTombstonesDir,
  getIncidentsDir,
  getDecisionsDir,
  getRunbooksDir,
  getLinksDir,
} from "../config/paths.js";

function _countForwardEntries(projectId: string, rootDir?: string): number {
  try {
    const path = join(getLinksDir(projectId, rootDir), "forward.json");
    if (!existsSync(path)) return 0;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object" ? Object.keys(data).length : 0;
  } catch {
    return 0;
  }
}
import { incidentSearch } from "../agent/incident/incident-store.js";
import { decisionSearch } from "../agent/decision/decision-store.js";
import { runbookList } from "../agent/runbook/runbook-store.js";

export interface MemoryHealthReport {
  totalEntries: number;
  totalChars: number;
  tierDistribution: { core: number; recall: number; archival: number };
  decay: {
    weightDistribution: { high: number; medium: number; low: number; veryLow: number };
    totalWithDecay: number;
  };
  tombstoned: { count: number };
  records: {
    incidents: { open: number; resolved: number };
    decisions: { proposed: number; accepted: number; superseded: number; rejected: number };
    runbooks: { total: number; avgConfidence: number };
  };
  links: {
    forwardEntries: number;
    orphans: number;
  };
  status: "healthy" | "warning" | "critical";
  recommendations: string[];
}

const KB = 1024;

function _countTombstones(projectId: string, rootDir?: string): number {
  const dir = getTombstonesDir(projectId, rootDir);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export function computeMemoryHealth(
  projectMemory: ProjectMemoryCore,
  rootDir?: string,
): MemoryHealthReport {
  const projectId = projectMemory.projectId;

  // Tier distribution
  const allEntries = tierList(projectMemory);
  const tierDistribution = { core: 0, recall: 0, archival: 0 };
  let totalChars = 0;
  const decayBuckets = { high: 0, medium: 0, low: 0, veryLow: 0 };
  let totalWithDecay = 0;

  for (const entry of allEntries) {
    const tier = entry.tier ?? "recall";
    tierDistribution[tier] += 1;
    if (tier !== "archival") {
      totalChars += (entry.body?.length ?? 0) + (entry.description?.length ?? 0);
    }

    const w = entry.decayWeight ?? 1.0;
    if (w >= 0.75) decayBuckets.high += 1;
    else if (w >= 0.5) decayBuckets.medium += 1;
    else if (w >= 0.25) decayBuckets.low += 1;
    else decayBuckets.veryLow += 1;
    if (entry.decayWeight !== undefined && entry.decayWeight < 1.0) totalWithDecay += 1;
  }

  // Tombstones
  const tombstonedCount = _countTombstones(projectId, rootDir);

  // Incidents
  const incidents = { open: 0, resolved: 0 };
  try {
    const incsDir = getIncidentsDir(projectId, rootDir);
    if (existsSync(incsDir)) {
      const open = incidentSearch(projectId, { status: "open", limit: 9999 }, rootDir);
      const resolved = incidentSearch(projectId, { status: "resolved", limit: 9999 }, rootDir);
      incidents.open = open.length;
      incidents.resolved = resolved.length;
    }
  } catch {
    // best-effort
  }

  // Decisions
  const decisions = { proposed: 0, accepted: 0, superseded: 0, rejected: 0 };
  try {
    const decsDir = getDecisionsDir(projectId, rootDir);
    if (existsSync(decsDir)) {
      const all = decisionSearch(projectId, { limit: 9999 }, rootDir);
      for (const d of all) {
        decisions[d.status] = (decisions[d.status] ?? 0) + 1;
      }
    }
  } catch {
    // best-effort
  }

  // Runbooks
  let rbTotal = 0;
  let rbConfSum = 0;
  try {
    const rbDir = getRunbooksDir(projectId, rootDir);
    if (existsSync(rbDir)) {
      const list = runbookList(projectId, rootDir);
      rbTotal = list.length;
      rbConfSum = list.reduce((s, rb) => s + (rb.confidence ?? 0), 0);
    }
  } catch {
    // best-effort
  }
  const runbooks = {
    total: rbTotal,
    avgConfidence: rbTotal > 0 ? Math.round((rbConfSum / rbTotal) * 100) / 100 : 0,
  };

  // Links
  let forwardEntries = 0;
  let orphansCount = 0;
  try {
    forwardEntries = _countForwardEntries(projectId, rootDir);
    orphansCount = linkOrphans(projectMemory).length;
  } catch {
    // best-effort
  }

  const totalEntries = allEntries.length;

  // Status determination
  let status: MemoryHealthReport["status"] = "healthy";
  const recommendations: string[] = [];

  if (totalChars > 200 * KB) {
    status = "critical";
    recommendations.push(
      `Memory is ${Math.round(totalChars / KB)}KB (>200KB) — run /memory compact urgently`,
    );
  } else if (totalChars > 100 * KB) {
    if (status === "healthy") status = "warning";
    recommendations.push(
      `Memory is ${Math.round(totalChars / KB)}KB (>100KB) — consider /memory compact`,
    );
  }

  if (incidents.open > 10) {
    status = "critical";
    recommendations.push(
      `${incidents.open} open incidents — review and resolve via /incident list`,
    );
  } else if (incidents.open > 5) {
    if (status === "healthy") status = "warning";
    recommendations.push(`${incidents.open} open incidents — review periodically`);
  }

  if (tombstonedCount > 100) {
    if (status === "healthy") status = "warning";
    recommendations.push(
      `${tombstonedCount} tombstoned entries — restore or purge via /memory decay-restore`,
    );
  }

  if (tierDistribution.recall > 500) {
    if (status === "healthy") status = "warning";
    recommendations.push(
      `${tierDistribution.recall} recall-tier entries — /memory compact will archive old ones`,
    );
  }

  const lowWeightPct =
    totalEntries > 0 ? ((decayBuckets.low + decayBuckets.veryLow) / totalEntries) * 100 : 0;
  if (lowWeightPct > 30) {
    if (status === "healthy") status = "warning";
    recommendations.push(
      `${Math.round(lowWeightPct)}% of memories have low decay weight — consider /memory decay-run`,
    );
  }

  if (orphansCount > 0) {
    recommendations.push(
      `${orphansCount} orphan link references — run /link orphans to review`,
    );
  }

  if (status === "healthy" && recommendations.length === 0) {
    recommendations.push("Memory is healthy ✅");
  }

  return {
    totalEntries,
    totalChars,
    tierDistribution,
    decay: {
      weightDistribution: decayBuckets,
      totalWithDecay,
    },
    tombstoned: { count: tombstonedCount },
    records: { incidents, decisions, runbooks },
    links: { forwardEntries, orphans: orphansCount },
    status,
    recommendations,
  };
}

/** Format a health report as markdown for TUI display. */
export function formatMemoryHealthMarkdown(report: MemoryHealthReport): string {
  const statusEmoji = { healthy: "✅", warning: "⚠️", critical: "🔴" }[report.status];
  const lines: string[] = [
    `# Memory Health ${statusEmoji} ${report.status}`,
    ``,
    `**Total entries:** ${report.totalEntries}  •  **Total chars (non-archival):** ${report.totalChars.toLocaleString()}`,
    ``,
    `## Tier Distribution`,
    `- core: ${report.tierDistribution.core}`,
    `- recall: ${report.tierDistribution.recall}`,
    `- archival: ${report.tierDistribution.archival}`,
    ``,
    `## Decay Weight Distribution`,
    `- high (≥0.75): ${report.decay.weightDistribution.high}`,
    `- medium (0.5-0.75): ${report.decay.weightDistribution.medium}`,
    `- low (0.25-0.5): ${report.decay.weightDistribution.low}`,
    `- very low (<0.25): ${report.decay.weightDistribution.veryLow}`,
    `- with decay applied: ${report.decay.totalWithDecay}`,
    ``,
    `## Tombstoned`,
    `- count: ${report.tombstoned.count}`,
    ``,
    `## Records`,
    `- incidents — open: ${report.records.incidents.open}, resolved: ${report.records.incidents.resolved}`,
    `- decisions — proposed: ${report.records.decisions.proposed}, accepted: ${report.records.decisions.accepted}, superseded: ${report.records.decisions.superseded}, rejected: ${report.records.decisions.rejected}`,
    `- runbooks — total: ${report.records.runbooks.total}, avg confidence: ${report.records.runbooks.avgConfidence}`,
    ``,
    `## Links`,
    `- forward entries: ${report.links.forwardEntries}`,
    `- orphans: ${report.links.orphans}`,
    ``,
    `## Recommendations`,
  ];

  for (const r of report.recommendations) lines.push(`- ${r}`);

  return lines.join("\n");
}
