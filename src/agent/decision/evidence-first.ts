/**
 * Evidence-first search (Wave 9 Phase 7) — port of MemKraft evidence_first.
 *
 * Concurrent (Promise.all) lookup across memory recall + incidents + decisions.
 * Merges and ranks by simple per-domain weights. YongKeun Park's "evidence
 * first" principle: prefer recorded evidence over guessing.
 */

import { searchRecall } from "../../memory/session-recall.js";
import { incidentSearch } from "../incident/incident-store.js";
import { decisionSearch } from "./decision-store.js";
import type { EvidenceFirstResult } from "./types.js";

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

const STATUS_WEIGHT: Record<string, number> = {
  accepted: 0.9,
  proposed: 0.6,
  superseded: 0.3,
  rejected: 0.1,
};

export async function evidenceFirst(
  projectId: string,
  query: string,
  options?: { limit?: number; rootDir?: string },
): Promise<EvidenceFirstResult> {
  if (!query || !query.trim()) {
    throw new Error("query must be non-empty");
  }

  const limit = options?.limit ?? 10;
  const rootDir = options?.rootDir;
  const t0 = performance.now();

  const memoryP = (async () => {
    try {
      const r = searchRecall({
        projectId,
        query,
        rootDir,
        maxResults: limit,
      });
      return r.results.map((hit) => ({
        _source: "memory" as const,
        sessionId: hit.sessionId,
        summary: hit.summary,
        score: hit.score,
        ageDays: hit.ageDays,
      }));
    } catch {
      return [];
    }
  })();

  const incidentP = (async () => {
    try {
      const recs = incidentSearch(projectId, { query, limit }, rootDir);
      return recs.map((r) => ({
        _source: "incident" as const,
        id: r.id,
        title: r.title,
        severity: r.severity,
        status: r.status,
        score: SEVERITY_WEIGHT[r.severity] ?? 0.25,
      }));
    } catch {
      return [];
    }
  })();

  const decisionP = (async () => {
    try {
      const recs = decisionSearch(projectId, { query, limit }, rootDir);
      return recs.map((r) => ({
        _source: "decision" as const,
        id: r.id,
        title: r.title,
        status: r.status,
        source: r.source,
        score: STATUS_WEIGHT[r.status] ?? 0.5,
      }));
    } catch {
      return [];
    }
  })();

  const [memory, incident, decision] = await Promise.all([memoryP, incidentP, decisionP]);

  const merged: EvidenceFirstResult["results"] = [...memory, ...incident, ...decision];
  merged.sort((a, b) => b.score - a.score);

  const sliced = merged.slice(0, limit);
  const elapsedMs = Math.max(0.001, performance.now() - t0);

  return {
    query,
    elapsedMs,
    counts: {
      memory: memory.length,
      incident: incident.length,
      decision: decision.length,
    },
    results: sliced,
  };
}
