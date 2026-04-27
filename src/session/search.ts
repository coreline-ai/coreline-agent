/**
 * Transcript search across session JSONL files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { parseSessionLine } from "./records.js";
import { normalizeMessage, type TranscriptEntryRecord, isTranscriptEntryRecord } from "./transcript.js";

export interface SearchTranscriptsOptions {
  sessionId?: string;
  role?: TranscriptEntryRecord["role"];
  toolName?: string;
  limit?: number;
  before?: string | Date;
  after?: string | Date;
  sessionsDir?: string;
}

function toTimeMs(value?: string | Date): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function matchesQuery(entry: TranscriptEntryRecord, query: string): boolean {
  const haystack = [
    entry.text,
    entry.toolName ?? "",
    entry.toolUseId ?? "",
    entry.role,
    entry.sessionId,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function computeSyntheticTimestamp(baseMs: number, lineIndex: number, entryIndex: number): string {
  return new Date(baseMs + (lineIndex * 1000) + (entryIndex * 50)).toISOString();
}

function readSessionEntries(sessionFile: string, sessionId: string): TranscriptEntryRecord[] {
  if (!existsSync(sessionFile)) {
    return [];
  }

  const raw = readFileSync(sessionFile, "utf-8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const fileStat = statSync(sessionFile);
  const baseMs = Number.isFinite(fileStat.birthtimeMs) ? fileStat.birthtimeMs : Date.now();
  const toolNameById = new Map<string, string>();
  const explicitEntries: TranscriptEntryRecord[] = [];
  const fallbackEntries: TranscriptEntryRecord[] = [];

  lines.forEach((line, lineIndex) => {
    let parsed: ReturnType<typeof parseSessionLine>;
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(line);
    } catch {
      rawValue = null;
    }

    if (isTranscriptEntryRecord(rawValue)) {
      explicitEntries.push(rawValue);
      return;
    }

    parsed = parseSessionLine(line);
    if (parsed.kind === "message") {
      const normalized = normalizeMessage(parsed.message, lineIndex, {
        sessionId,
        timestamp: computeSyntheticTimestamp(baseMs, lineIndex, 0),
        toolNameById,
      });
      fallbackEntries.push(...normalized);
      return;
    }

    if (parsed.kind === "structured" && isTranscriptEntryRecord(parsed.record)) {
      explicitEntries.push(parsed.record);
    }
  });

  if (explicitEntries.length === 0) {
    return fallbackEntries;
  }

  return [
    ...explicitEntries,
    ...fallbackEntries.filter((entry) => !hasEquivalentExplicitEntry(entry, explicitEntries)),
  ];
}

function hasEquivalentExplicitEntry(entry: TranscriptEntryRecord, explicitEntries: TranscriptEntryRecord[]): boolean {
  return explicitEntries.some((explicit) =>
    explicit.turnIndex === entry.turnIndex
    && explicit.role === entry.role
    && explicit.toolUseId === entry.toolUseId
    && explicit.text === entry.text
  );
}

export function searchTranscripts(
  query: string,
  options: SearchTranscriptsOptions = {},
): TranscriptEntryRecord[] {
  const searchRoot = options.sessionsDir ?? paths.sessionsDir;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const beforeMs = toTimeMs(options.before);
  const afterMs = toTimeMs(options.after);
  const sessionFiles = existsSync(searchRoot)
    ? readdirSync(searchRoot).filter((file) => file.endsWith(".jsonl")).sort()
    : [];
  const results: TranscriptEntryRecord[] = [];

  for (const fileName of sessionFiles) {
    const sessionId = fileName.replace(/\.jsonl$/, "");
    if (options.sessionId && options.sessionId !== sessionId) {
      continue;
    }

    const sessionFile = join(searchRoot, fileName);
    const entries = readSessionEntries(sessionFile, sessionId);
    for (const entry of entries) {
      if (options.role && entry.role !== options.role) {
        continue;
      }

      if (options.toolName && entry.toolName !== options.toolName) {
        continue;
      }

      const entryMs = Date.parse(entry.timestamp);
      if (afterMs !== null && !(entryMs > afterMs)) {
        continue;
      }

      if (beforeMs !== null && !(entryMs < beforeMs)) {
        continue;
      }

      if (!matchesQuery(entry, normalizedQuery)) {
        continue;
      }

      results.push(entry);
    }
  }

  const ordered = results.sort((a, b) => {
    const timeA = Date.parse(a.timestamp);
    const timeB = Date.parse(b.timestamp);
    if (timeA !== timeB) return timeA - timeB;
    if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
    return a.sessionId.localeCompare(b.sessionId);
  });

  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  return ordered.slice(0, limit);
}
