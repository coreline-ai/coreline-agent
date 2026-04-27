/**
 * MemoryRecall tool — search past session summaries by keyword.
 */

import { z } from "zod";
import { buildTool } from "../types.js";
import type { ToolResult, ToolUseContext } from "../types.js";
import { searchRecall, type SearchRecallResult } from "../../memory/session-recall.js";

const inputSchema = z.object({
  query: z.string().min(1).describe("Keywords to search in past session summaries"),
  timeRangeDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max age in days, default 90"),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max hits returned, default 5"),
  minSimilarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum containment similarity threshold, default 0.3"),
});

type MemoryRecallInput = z.infer<typeof inputSchema>;

type MemoryRecallOutput = SearchRecallResult;

function emptyResult(query: string): MemoryRecallOutput {
  return {
    results: [],
    counts: {
      decisionsMatched: 0,
      decisionsTotal: 0,
      skippedStale: 0,
      skippedLowSimilarity: 0,
      skippedCorrupt: 0,
    },
    query,
  };
}

function formatHit(hit: MemoryRecallOutput["results"][number], index: number): string {
  const ageDays = hit.ageDays.toFixed(1);
  const sim = hit.similarity.toFixed(3);
  const recency = hit.recencyWeight.toFixed(3);
  const score = hit.score.toFixed(3);
  const summary = hit.summary.trim().replace(/\s+/g, " ") || "(no summary)";
  return [
    `${index + 1}. session: ${hit.sessionId}`,
    `   indexedAt: ${hit.indexedAt}`,
    `   ageDays: ${ageDays}`,
    `   similarity: ${sim}  recencyWeight: ${recency}  score: ${score}`,
    `   summary: ${summary}`,
  ].join("\n");
}

export const MemoryRecallTool = buildTool<MemoryRecallInput, MemoryRecallOutput>({
  name: "MemoryRecall",
  description:
    "Search past session summaries by keyword using Containment similarity + recency weighting. " +
    "Returns matching sessions with similarity scores. Use to recall decisions or discussions from prior sessions.",
  maxResultSizeChars: 20_000,

  inputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: "allow", reason: "Read-only cross-session recall." }),

  async call(input, context: ToolUseContext): Promise<ToolResult<MemoryRecallOutput>> {
    const projectId = context.projectMemory?.projectId ?? "";
    if (!projectId) {
      return { data: emptyResult(input.query), isError: false };
    }
    const result = searchRecall({
      projectId,
      query: input.query,
      timeRangeDays: input.timeRangeDays,
      maxResults: input.maxResults,
      minSimilarity: input.minSimilarity,
    });
    return { data: result, isError: false };
  },

  formatResult(output): string {
    const { results, counts, query } = output;
    const header = [
      "MEMORY_RECALL_RESULT",
      `query: ${query}`,
      `matched: ${counts.decisionsMatched} / ${counts.decisionsTotal}`,
      `skippedStale: ${counts.skippedStale}  skippedLowSimilarity: ${counts.skippedLowSimilarity}  skippedCorrupt: ${counts.skippedCorrupt}`,
      `returned: ${results.length}`,
    ];

    if (results.length === 0) {
      return [
        ...header,
        "",
        "No matching past sessions found.",
        "NEXT_STEP: Broaden the query, increase timeRangeDays, or lower minSimilarity.",
      ].join("\n");
    }

    return [
      ...header,
      "",
      "HITS_START",
      ...results.map((hit, i) => formatHit(hit, i)),
      "HITS_END",
    ].join("\n");
  },
});
