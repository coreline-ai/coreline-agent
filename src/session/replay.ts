/**
 * Session replay formatting.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { parseSessionLine } from "./records.js";
import { normalizeMessage, type TranscriptEntryRecord, isTranscriptEntryRecord } from "./transcript.js";

export interface ReplaySessionOptions {
  sessionsDir?: string;
}

function computeSyntheticTimestamp(baseMs: number, lineIndex: number, entryIndex: number): string {
  return new Date(baseMs + (lineIndex * 1000) + (entryIndex * 50)).toISOString();
}

function loadSessionEntries(sessionId: string, sessionsDir: string): TranscriptEntryRecord[] {
  const filePath = join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const fileStat = statSync(filePath);
  const baseMs = Number.isFinite(fileStat.birthtimeMs) ? fileStat.birthtimeMs : Date.now();
  const toolNameById = new Map<string, string>();
  const explicitEntries: TranscriptEntryRecord[] = [];
  const fallbackEntries: TranscriptEntryRecord[] = [];

  lines.forEach((line, lineIndex) => {
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

    const parsed = parseSessionLine(line);
    if (parsed.kind === "message") {
      fallbackEntries.push(
        ...normalizeMessage(parsed.message, lineIndex, {
          sessionId,
          timestamp: computeSyntheticTimestamp(baseMs, lineIndex, 0),
          toolNameById,
        }),
      );
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

function formatTime(timestamp: string): string {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) {
    return "--:--";
  }

  return time.toISOString().slice(11, 16);
}

function formatEntry(entry: TranscriptEntryRecord): string {
  const label = entry.role === "tool"
    ? `tool${entry.toolName ? `(${entry.toolName})` : ""}`
    : entry.role;
  const text = entry.text.replace(/\s+/g, " ").trim();
  return `[${formatTime(entry.timestamp)}] ${label}: ${text}`;
}

export function replaySession(sessionId: string, options: ReplaySessionOptions = {}): string {
  const sessionsDir = options.sessionsDir ?? paths.sessionsDir;
  const entries = loadSessionEntries(sessionId, sessionsDir)
    .slice()
    .sort((a, b) => {
      const timeA = Date.parse(a.timestamp);
      const timeB = Date.parse(b.timestamp);
      if (timeA !== timeB) return timeA - timeB;
      if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
      const roleOrder = (role: TranscriptEntryRecord["role"]): number => {
        if (role === "user") return 0;
        if (role === "assistant") return 1;
        return 2;
      };
      return roleOrder(a.role) - roleOrder(b.role);
    });

  if (entries.length === 0) {
    return "";
  }

  return entries.map(formatEntry).join("\n");
}
