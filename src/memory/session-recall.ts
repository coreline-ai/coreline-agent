/**
 * Cross-session recall — index past session summaries and search via
 * Containment similarity + recency weighting (MemKraft prompt_evidence.py port).
 * Zero embedding deps — stdlib only.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureSessionRecallDir, getSessionRecallDir } from "../config/paths.js";
import type { ChatMessage, ContentBlock } from "../agent/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUMMARY_MAX_CHARS = 400;
const MAX_TOKENS = 200;
const MAX_SUMMARY_MESSAGES = 12;
const TOKEN_REGEX = /[\w가-힣]+/gu;

const STOPWORDS = new Set<string>([
  // Common English stopwords
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "here",
  "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me",
  "my", "no", "not", "now", "of", "on", "or", "our", "out", "so", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "to", "too", "up", "us", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "why", "will", "with", "would", "you", "your", "yours",
  // Session/agent specific noise
  "session", "agent", "user", "assistant",
]);

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface IndexSessionOptions {
  projectId: string;
  sessionId: string;
  messages: ChatMessage[];
  /** Timestamp when session ended. Default: now. */
  indexedAt?: string;
  /** Optional cwd or project root — for metadata. */
  cwd?: string;
  rootDir?: string;
}

export interface IndexSessionResult {
  written: boolean;
  path?: string;
  error?: string;
}

export interface SessionRecallIndex {
  sessionId: string;
  indexedAt: string;
  summary: string;
  tokens: string[];
  messageCount: number;
  cwd?: string;
}

export interface SearchRecallOptions {
  projectId: string;
  query: string;
  timeRangeDays?: number;
  maxResults?: number;
  minSimilarity?: number;
  rootDir?: string;
  /** Reference "now" for deterministic tests. Default Date.now(). */
  now?: number;
}

export interface RecallHit {
  sessionId: string;
  summary: string;
  indexedAt: string;
  similarity: number;
  recencyWeight: number;
  score: number;
  ageDays: number;
}

export interface SearchRecallCounts {
  decisionsMatched: number;
  decisionsTotal: number;
  skippedStale: number;
  skippedLowSimilarity: number;
  skippedCorrupt: number;
}

export interface SearchRecallResult {
  results: RecallHit[];
  counts: SearchRecallCounts;
  query: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of message.content as ContentBlock[]) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") {
        parts.push(block.content);
      }
    }
  }
  return parts.join(" ");
}

function buildSummary(messages: ChatMessage[]): string {
  const pieces: string[] = [];
  const limit = Math.min(messages.length, MAX_SUMMARY_MESSAGES);
  for (let i = 0; i < limit; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractMessageText(msg).replace(/\s+/g, " ").trim();
    if (!text) continue;
    pieces.push(`[${msg.role}] ${text}`);
    const joined = pieces.join(" | ");
    if (joined.length >= SUMMARY_MAX_CHARS) break;
  }
  const joined = pieces.join(" | ").trim();
  return joined.length > SUMMARY_MAX_CHARS ? joined.slice(0, SUMMARY_MAX_CHARS).trim() : joined;
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.match(TOKEN_REGEX);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const token = raw.toLowerCase();
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

function extractSessionText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractMessageText(msg);
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

function safeReadIndex(filePath: string): SessionRecallIndex | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sessionId !== "string") return null;
    if (typeof obj.indexedAt !== "string") return null;
    if (typeof obj.summary !== "string") return null;
    if (!Array.isArray(obj.tokens)) return null;
    const tokens = obj.tokens.filter((t): t is string => typeof t === "string");
    const messageCount = typeof obj.messageCount === "number" ? obj.messageCount : 0;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
    return {
      sessionId: obj.sessionId,
      indexedAt: obj.indexedAt,
      summary: obj.summary,
      tokens,
      messageCount,
      cwd,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Index a session: extract summary + tokens, write JSON file. Best-effort. */
export function indexSession(options: IndexSessionOptions): IndexSessionResult {
  try {
    if (!options.projectId) {
      return { written: false, error: "projectId is required" };
    }
    if (!options.sessionId) {
      return { written: false, error: "sessionId is required" };
    }
    if (!Array.isArray(options.messages) || options.messages.length === 0) {
      return { written: false, error: "messages is empty" };
    }

    const dir = ensureSessionRecallDir(options.projectId, options.rootDir);
    const summary = buildSummary(options.messages);
    const combinedText = extractSessionText(options.messages);
    const tokens = tokenize(combinedText);
    const indexedAt = options.indexedAt ?? new Date().toISOString();

    const record: SessionRecallIndex = {
      sessionId: options.sessionId,
      indexedAt,
      summary,
      tokens,
      messageCount: options.messages.length,
      cwd: options.cwd,
    };

    const filePath = join(dir, `${options.sessionId}.json`);
    writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    return { written: true, path: filePath };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { written: false, error };
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function containmentSimilarity(queryTokens: string[], sessionTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const sessionSet = new Set(sessionTokens);
  let hits = 0;
  for (const qt of queryTokens) {
    if (sessionSet.has(qt)) hits += 1;
  }
  return hits / queryTokens.length;
}

function emptyCounts(): SearchRecallCounts {
  return {
    decisionsMatched: 0,
    decisionsTotal: 0,
    skippedStale: 0,
    skippedLowSimilarity: 0,
    skippedCorrupt: 0,
  };
}

/** Search past session summaries by keyword. */
export function searchRecall(options: SearchRecallOptions): SearchRecallResult {
  const query = options.query ?? "";
  const timeRangeDays = options.timeRangeDays ?? 90;
  const maxResults = options.maxResults ?? 5;
  const minSimilarity = options.minSimilarity ?? 0.3;
  const now = options.now ?? Date.now();

  const counts = emptyCounts();

  if (!options.projectId) {
    return { results: [], counts, query };
  }

  const queryTokens = tokenize(query);
  const dir = getSessionRecallDir(options.projectId, options.rootDir);
  if (!existsSync(dir)) {
    return { results: [], counts, query };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { results: [], counts, query };
  }

  const hits: RecallHit[] = [];

  for (const fileName of entries) {
    const filePath = join(dir, fileName);
    const record = safeReadIndex(filePath);
    if (!record) {
      counts.skippedCorrupt += 1;
      continue;
    }

    counts.decisionsTotal += 1;

    const indexedAtMs = Date.parse(record.indexedAt);
    if (!Number.isFinite(indexedAtMs)) {
      counts.skippedCorrupt += 1;
      continue;
    }

    const ageDays = Math.max(0, (now - indexedAtMs) / 86_400_000);
    if (ageDays > timeRangeDays) {
      counts.skippedStale += 1;
      continue;
    }

    const similarity = containmentSimilarity(queryTokens, record.tokens);
    if (similarity < minSimilarity) {
      counts.skippedLowSimilarity += 1;
      continue;
    }

    // Guard against timeRangeDays=0 → division-by-zero → NaN score.
    // Parallel mode (prompt-evidence-search.ts uses the same guard).
    const safeRange = timeRangeDays > 0 ? timeRangeDays : 1;
    const recencyWeight = Math.max(0.1, 1 - ageDays / safeRange);
    const score = similarity * recencyWeight;

    counts.decisionsMatched += 1;
    hits.push({
      sessionId: record.sessionId,
      summary: record.summary,
      indexedAt: record.indexedAt,
      similarity,
      recencyWeight,
      score,
      ageDays,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.indexedAt.localeCompare(a.indexedAt);
  });

  return {
    results: hits.slice(0, maxResults),
    counts,
    query,
  };
}
