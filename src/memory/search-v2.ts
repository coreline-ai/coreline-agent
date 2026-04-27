/**
 * Search v2 — searchTemporal, searchExpand, and unified searchV2 over memory + session.
 */

import * as pathsModule from "../config/paths.js";
import { ProjectMemory } from "./project-memory.js";
import { searchRecall, tokenize } from "./session-recall.js";
import type { MemoryEntry } from "./types.js";
import type {
  DateHint,
  SearchDomain,
  SearchSortBy,
  SearchV2Hit,
  SearchV2Options,
  SearchV2Result,
} from "./search-v2-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_BOOST_FACTOR = 2;
const DEFAULT_TIME_RANGE_DAYS = 365;
const PREVIEW_CHARS = 200;
const MAX_EXPAND_VARIANTS = 8;
const RECENCY_HALFLIFE_DAYS = 30;

const DEFAULT_SYNONYMS: Record<string, string[]> = {
  build: ["compile", "bundle", "make"],
  compile: ["build", "transpile"],
  bundle: ["build", "package"],
  error: ["issue", "bug", "fail", "problem"],
  bug: ["error", "issue", "defect"],
  issue: ["error", "bug", "problem"],
  test: ["spec", "verify", "validate"],
  spec: ["test", "specification"],
  run: ["execute", "launch", "invoke"],
  execute: ["run", "launch"],
  fix: ["repair", "resolve", "patch"],
  repair: ["fix", "resolve"],
  install: ["setup", "deploy"],
  setup: ["install", "configure"],
  // Korean
  "오류": ["에러", "버그", "문제"],
  "에러": ["오류", "버그"],
  "버그": ["오류", "에러"],
  "빌드": ["컴파일"],
  "컴파일": ["빌드"],
  "테스트": ["검증", "확인"],
  "검증": ["테스트", "확인"],
  "확인": ["테스트", "검증"],
};

// ---------------------------------------------------------------------------
// Public Types (re-export)
// ---------------------------------------------------------------------------

export type {
  DateHint,
  SearchDomain,
  SearchSortBy,
  SearchV2Hit,
  SearchV2Options,
  SearchV2Result,
} from "./search-v2-types.js";

export interface SearchTemporalOptions extends SearchV2Options {
  /** Natural language hint ("yesterday", "last week", "2026-04"), Date, or undefined. */
  dateHint?: string | Date;
  /** Override boost factor (default 2). */
  boostFactor?: number;
}

export interface SearchExpandOptions extends SearchV2Options {
  /** Synonym dict override (default uses built-in). */
  synonyms?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// parseDateHint
// ---------------------------------------------------------------------------

/**
 * Parse a natural-language or ISO-ish date hint.
 * Returns null if input cannot be interpreted.
 */
export function parseDateHint(
  input: string | Date | undefined,
  now: number = Date.now(),
  boostFactor: number = DEFAULT_BOOST_FACTOR,
): DateHint | null {
  if (input == null) return null;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return { anchorDate: input, windowDays: 1, boostFactor };
  }

  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const oneDay = 86_400_000;

  // Keyword forms (English + Korean)
  if (raw === "today" || raw === "오늘") {
    return { anchorDate: new Date(now), windowDays: 1, boostFactor };
  }
  if (raw === "yesterday" || raw === "어제") {
    return { anchorDate: new Date(now - oneDay), windowDays: 1, boostFactor };
  }
  if (raw === "last week" || raw === "지난주" || raw === "지난 주") {
    return { anchorDate: new Date(now - 7 * oneDay), windowDays: 7, boostFactor };
  }
  if (raw === "this week" || raw === "이번주" || raw === "이번 주") {
    return { anchorDate: new Date(now), windowDays: 7, boostFactor };
  }
  if (raw === "last month" || raw === "지난달" || raw === "지난 달") {
    return { anchorDate: new Date(now - 30 * oneDay), windowDays: 30, boostFactor };
  }
  if (raw === "this month" || raw === "이번달" || raw === "이번 달") {
    return { anchorDate: new Date(now), windowDays: 30, boostFactor };
  }

  // ISO-ish: YYYY-MM-DD
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const anchor = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(anchor.getTime())) return null;
    return { anchorDate: anchor, windowDays: 1, boostFactor };
  }

  // ISO-ish: YYYY-MM (mid-month, window 30)
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(raw);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return null;
    const anchor = new Date(Date.UTC(year, month - 1, 15));
    if (Number.isNaN(anchor.getTime())) return null;
    return { anchorDate: anchor, windowDays: 30, boostFactor };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_CHARS ? collapsed.slice(0, PREVIEW_CHARS) : collapsed;
}

function entryTimestampMs(entry: MemoryEntry): number {
  // Prefer lastAccessed (YYYY-MM-DD), fallback to recordedAt, else 0.
  if (entry.lastAccessed) {
    const ms = Date.parse(entry.lastAccessed);
    if (Number.isFinite(ms)) return ms;
  }
  if (entry.recordedAt) {
    const ms = Date.parse(entry.recordedAt);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function memoryEntryScore(queryTokens: string[], entry: MemoryEntry): number {
  if (queryTokens.length === 0) return 0;
  const haystack = `${entry.name} ${entry.description} ${entry.body}`;
  const haystackTokens = new Set(tokenize(haystack));
  let hits = 0;
  for (const qt of queryTokens) {
    if (haystackTokens.has(qt)) hits += 1;
  }
  return hits / queryTokens.length;
}

function recencyWeight(timestampMs: number, now: number): number {
  if (timestampMs <= 0) return 0.1;
  const ageDays = Math.max(0, (now - timestampMs) / 86_400_000);
  // Exponential decay with halflife = 30 days.
  return Math.max(0.1, Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS));
}

function searchMemoryEntries(
  query: string,
  projectId: string,
  rootDir: string | undefined,
  threshold: number,
  now: number,
): SearchV2Hit[] {
  // ProjectMemory keys storage off `projectId`. Construct an instance with a
  // placeholder cwd, then rebind its paths/projectId so it reads the supplied
  // project's memory directory under `rootDir`.
  const memory = projectMemoryFromProjectId(projectId, rootDir);
  let entries: MemoryEntry[];
  try {
    entries = memory.loadAll().entries;
  } catch {
    return [];
  }

  const queryTokens = tokenize(query);
  const hits: SearchV2Hit[] = [];
  for (const entry of entries) {
    if (entry.tombstoned) continue;
    const score = memoryEntryScore(queryTokens, entry);
    if (score < threshold) continue;
    const ts = entryTimestampMs(entry);
    const recency = recencyWeight(ts, now);
    hits.push({
      source: "memory",
      id: entry.name,
      title: entry.description || entry.name,
      preview: makePreview(entry.body),
      score,
      recencyWeight: recency,
      rankingScore: score,
      metadata: {
        type: entry.type,
        tier: entry.tier,
        lastAccessed: entry.lastAccessed,
        timestampMs: ts,
      },
    });
  }
  return hits;
}

/**
 * Build a ProjectMemory instance whose `projectId` matches the supplied id.
 * ProjectMemory's storage paths are derived from `projectId` + `rootDir`,
 * so we override the readonly fields after construction to retarget at the
 * requested project (the original cwd cannot be recovered from a hash).
 */
function projectMemoryFromProjectId(projectId: string, rootDir: string | undefined): ProjectMemory {
  const inst = new ProjectMemory("/tmp/__search_v2_placeholder__", { rootDir });
  const projectDir = pathsModule.getProjectDir(projectId, rootDir);
  const memoryDir = pathsModule.getProjectMemoryDir(projectId, rootDir);
  (inst as { projectId: string }).projectId = projectId;
  (inst as { projectDir: string }).projectDir = projectDir;
  (inst as { memoryDir: string }).memoryDir = memoryDir;
  (inst as { metadataPath: string }).metadataPath = `${projectDir}/metadata.json`;
  return inst;
}

function searchSessionEntries(
  query: string,
  projectId: string,
  rootDir: string | undefined,
  threshold: number,
  now: number,
): SearchV2Hit[] {
  const recall = searchRecall({
    projectId,
    query,
    rootDir,
    timeRangeDays: DEFAULT_TIME_RANGE_DAYS,
    maxResults: 1_000,
    minSimilarity: threshold,
    now,
  });
  return recall.results.map((hit) => ({
    source: "session" as const,
    id: hit.sessionId,
    title: hit.summary.slice(0, 80),
    preview: makePreview(hit.summary),
    score: hit.similarity,
    recencyWeight: hit.recencyWeight,
    rankingScore: hit.score,
    metadata: {
      indexedAt: hit.indexedAt,
      ageDays: hit.ageDays,
      timestampMs: Date.parse(hit.indexedAt),
    },
  }));
}

function getDomain(options: SearchV2Options): SearchDomain {
  return options.domain ?? "all";
}

function applySort(hits: SearchV2Hit[], sortBy: SearchSortBy): SearchV2Hit[] {
  if (sortBy === "recency") {
    return [...hits].sort((a, b) => {
      const aTs = (a.metadata?.timestampMs as number | undefined) ?? 0;
      const bTs = (b.metadata?.timestampMs as number | undefined) ?? 0;
      if (bTs !== aTs) return bTs - aTs;
      return b.rankingScore - a.rankingScore;
    });
  }
  return [...hits].sort((a, b) => b.rankingScore - a.rankingScore);
}

function buildResult(
  query: string,
  hits: SearchV2Hit[],
  topK: number,
  sortBy: SearchSortBy,
): SearchV2Result {
  const sorted = applySort(hits, sortBy);
  const sliced = sorted.slice(0, topK);
  const memoryCount = hits.filter((h) => h.source === "memory").length;
  const sessionCount = hits.filter((h) => h.source === "session").length;
  return {
    query,
    totalMatched: hits.length,
    results: sliced,
    domains: { memory: memoryCount, session: sessionCount },
  };
}

// ---------------------------------------------------------------------------
// searchV2
// ---------------------------------------------------------------------------

/**
 * Unified search across memory + session domains with sortBy + domain filter.
 */
export function searchV2(options: SearchV2Options): SearchV2Result {
  const {
    query,
    projectId,
    rootDir,
    sortBy = "relevance",
    topK = DEFAULT_TOP_K,
    scoreThreshold = DEFAULT_THRESHOLD,
  } = options;
  const now = options.now ?? Date.now();
  const domain = getDomain(options);

  if (!query || !projectId) {
    return { query, totalMatched: 0, results: [], domains: { memory: 0, session: 0 } };
  }

  const memHits =
    domain === "memory" || domain === "all"
      ? searchMemoryEntries(query, projectId, rootDir, scoreThreshold, now)
      : [];
  const sessHits =
    domain === "session" || domain === "all"
      ? searchSessionEntries(query, projectId, rootDir, scoreThreshold, now)
      : [];

  const all = [...memHits, ...sessHits];
  return buildResult(query, all, topK, sortBy);
}

// ---------------------------------------------------------------------------
// searchTemporal
// ---------------------------------------------------------------------------

/**
 * Search with temporal boost — items closer to the date hint score higher.
 * Falls back to plain recency-influenced ranking if no hint provided or unparseable.
 */
export function searchTemporal(options: SearchTemporalOptions): SearchV2Result {
  const now = options.now ?? Date.now();
  const boostFactor = options.boostFactor ?? DEFAULT_BOOST_FACTOR;
  const hint = parseDateHint(options.dateHint, now, boostFactor);

  // Run baseline searchV2 with relevance sort, then apply temporal boost.
  const base = searchV2({ ...options, sortBy: "relevance", topK: 10_000 });

  if (!hint) {
    // No hint — fall back to recency ordering.
    return buildResult(options.query, base.results, options.topK ?? DEFAULT_TOP_K, "recency");
  }

  const anchorMs = hint.anchorDate.getTime();
  const windowMs = hint.windowDays * 86_400_000;

  const boosted: SearchV2Hit[] = base.results.map((hit) => {
    const ts = (hit.metadata?.timestampMs as number | undefined) ?? 0;
    if (ts <= 0) return hit;
    const distanceMs = Math.abs(ts - anchorMs);
    if (distanceMs <= windowMs) {
      return {
        ...hit,
        rankingScore: hit.rankingScore * hint.boostFactor,
        metadata: { ...hit.metadata, temporalBoost: hint.boostFactor },
      };
    }
    return hit;
  });

  return buildResult(options.query, boosted, options.topK ?? DEFAULT_TOP_K, "relevance");
}

// ---------------------------------------------------------------------------
// searchExpand
// ---------------------------------------------------------------------------

function expandQueries(query: string, dict: Record<string, string[]>): string[] {
  const tokenRe = /[\w가-힣]+/gu;
  const tokens = query.match(tokenRe);
  if (!tokens || tokens.length === 0) return [query];

  // For each token build a list of variants (original + synonyms).
  const variantLists: string[][] = tokens.map((tok) => {
    const lower = tok.toLowerCase();
    const syns = dict[lower] ?? dict[tok] ?? [];
    return [tok, ...syns];
  });

  // Cartesian product — capped at MAX_EXPAND_VARIANTS.
  const queries: string[] = [];
  const indices = new Array<number>(variantLists.length).fill(0);

  // Compute total combinations; iterate up to cap.
  let total = 1;
  for (const list of variantLists) total *= list.length;
  total = Math.min(total, MAX_EXPAND_VARIANTS);

  for (let i = 0; i < total; i += 1) {
    const parts: string[] = [];
    for (let j = 0; j < variantLists.length; j += 1) {
      const list = variantLists[j]!;
      const idx = indices[j]!;
      parts.push(list[idx]!);
    }
    queries.push(parts.join(" "));
    // Increment mixed-radix indices.
    for (let j = variantLists.length - 1; j >= 0; j -= 1) {
      const list = variantLists[j]!;
      indices[j] = (indices[j]! + 1) % list.length;
      if (indices[j] !== 0) break;
    }
  }
  return queries;
}

/**
 * Expand query with synonyms, run multi-query search, merge results
 * (max-score by id).
 */
export function searchExpand(options: SearchExpandOptions): SearchV2Result {
  const dict = options.synonyms ?? DEFAULT_SYNONYMS;
  const variants = expandQueries(options.query, dict);

  const merged = new Map<string, SearchV2Hit>();
  for (const variant of variants) {
    const r = searchV2({ ...options, query: variant, topK: 10_000 });
    for (const hit of r.results) {
      const key = `${hit.source}:${hit.id}`;
      const existing = merged.get(key);
      if (!existing || hit.rankingScore > existing.rankingScore) {
        merged.set(key, hit);
      }
    }
  }

  const all = Array.from(merged.values());
  const sortBy = options.sortBy ?? "relevance";
  return buildResult(options.query, all, options.topK ?? DEFAULT_TOP_K, sortBy);
}
