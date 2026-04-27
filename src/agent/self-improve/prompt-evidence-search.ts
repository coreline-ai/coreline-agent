/**
 * Prompt evidence search — Containment + recency weighting
 * (MemKraft prompt_evidence.py port).
 *
 * Zero embedding deps: asymmetric containment similarity on word tokens
 * with Unicode-aware tokenization (한글 지원) and stopword filtering.
 */

import type { EvidenceRecord } from "./types.js";

export interface PromptEvidenceSearchOptions {
  records: EvidenceRecord[];
  query: string;
  /** Drop records older than this many days. Default 90. Non-positive disables. */
  timeRangeDays?: number;
  /** 0-1; records below this similarity are dropped. Default 0.3. */
  minSimilarity?: number;
  /** Max results returned. Default 5. */
  maxResults?: number;
}

export interface PromptEvidenceHit {
  record: EvidenceRecord;
  similarity: number;
  recencyWeight: number;
  /** similarity * recencyWeight — used for ranking. */
  score: number;
  ageDays: number;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  // common English stopwords
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "s",
  "so",
  "t",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "we",
  "you",
  "your",
  // MemKraft-specific noise tokens
  "prompt",
  "eval",
  "iteration",
]);

const TOKEN_REGEX = /[\w가-힣]+/gu;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const matches = text.toLowerCase().match(TOKEN_REGEX);
  if (!matches) return tokens;
  for (const token of matches) {
    if (token.length <= 1) continue;
    if (STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function recordText(record: EvidenceRecord): string {
  const meta = record.metadata ?? {};
  const title =
    typeof (meta as { title?: unknown }).title === "string"
      ? ((meta as { title: string }).title)
      : "";
  const unclear = record.outcome.unclearPoints?.join(" ") ?? "";
  let metaJson = "";
  try {
    metaJson = JSON.stringify(meta);
  } catch {
    metaJson = "";
  }
  return `${title} ${unclear} ${metaJson}`.trim();
}

function containment(querySet: Set<string>, recordSet: Set<string>): number {
  if (querySet.size === 0) return 0;
  let overlap = 0;
  for (const tok of querySet) {
    if (recordSet.has(tok)) overlap += 1;
  }
  return overlap / querySet.size;
}

export function searchPromptEvidence(
  options: PromptEvidenceSearchOptions,
): PromptEvidenceHit[] {
  const {
    records,
    query,
    timeRangeDays = 90,
    minSimilarity = 0.3,
    maxResults = 5,
  } = options;

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0 || records.length === 0) {
    return [];
  }

  const now = Date.now();
  const hits: PromptEvidenceHit[] = [];

  for (const record of records) {
    const invokedMs = Date.parse(record.invokedAt);
    const ageDays = Number.isFinite(invokedMs)
      ? (now - invokedMs) / 86_400_000
      : Number.POSITIVE_INFINITY;

    // Age filter — drop stale records when a positive window is configured.
    if (timeRangeDays > 0 && ageDays > timeRangeDays) continue;

    const recTokens = tokenize(recordText(record));
    const similarity = containment(queryTokens, recTokens);
    if (similarity < minSimilarity) continue;

    let recencyWeight: number;
    if (timeRangeDays <= 0 || !Number.isFinite(ageDays)) {
      recencyWeight = timeRangeDays <= 0 ? 1 : 0.1;
    } else {
      recencyWeight = Math.max(0.1, 1 - ageDays / timeRangeDays);
    }

    hits.push({
      record,
      similarity,
      recencyWeight,
      score: similarity * recencyWeight,
      ageDays: Number.isFinite(ageDays) ? ageDays : Number.POSITIVE_INFINITY,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aMs = Date.parse(a.record.invokedAt) || 0;
    const bMs = Date.parse(b.record.invokedAt) || 0;
    return bMs - aMs;
  });

  return hits.slice(0, Math.max(0, maxResults));
}
