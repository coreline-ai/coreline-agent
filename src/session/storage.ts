/**
 * Session Storage — JSONL-based session persistence.
 *
 * Each session is a file: ~/.coreline-agent/sessions/{id}.jsonl
 * Each line is either:
 * - a raw ChatMessage JSON object (backward compatible)
 * - a structured record envelope with `_type`
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths, ensureConfigDirs } from "../config/paths.js";
import type { ChatMessage } from "../agent/types.js";
import type { AgentTraceRecord } from "../agent/reliability/types.js";
import type { TranscriptEntryRecord } from "./transcript.js";
import {
  createAgentTraceRecord,
  createSessionHeaderRecord,
  parseSessionLine,
  createSubAgentRunRecord,
  createPlanRunRecord,
  formatSubAgentRunForDisplay,
  type ChildExecutionRecord,
  type PlanRunRecord,
  type SubAgentRunRecord,
} from "./records.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  filePath: string;
  createdAt: Date;
  messageCount: number;
}

export interface SessionData {
  id: string;
  messages: ChatMessage[];
  subAgentRuns: SubAgentRunRecord[];
  planRuns: PlanRunRecord[];
  agentTraces: AgentTraceRecord[];
  childExecutions: SubAgentRunRecord[];
}

function toSortableTime(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function dedupePlanRuns(records: PlanRunRecord[]): PlanRunRecord[] {
  const latestById = new Map<string, PlanRunRecord>();

  for (const record of records) {
    const existing = latestById.get(record.planRunId);
    if (!existing || toSortableTime(record.createdAt) >= toSortableTime(existing.createdAt)) {
      latestById.set(record.planRunId, record);
    }
  }

  return [...latestById.values()].sort((a, b) => toSortableTime(a.createdAt) - toSortableTime(b.createdAt));
}

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

export function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:\-T]/g, "").slice(0, 14);
  const shortUuid = randomUUID().slice(0, 8);
  return `${dateStr}_${shortUuid}`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function sessionPath(id: string): string {
  return join(paths.sessionsDir, `${id}.jsonl`);
}

/** Append a single message to the session file */
export function appendMessage(sessionId: string, message: ChatMessage): void {
  ensureConfigDirs();
  const filePath = sessionPath(sessionId);

  const serialized = JSON.stringify(message);
  appendFileSync(filePath, serialized + "\n", "utf-8");
}

/** Append normalized transcript records to the session file */
export function appendTranscriptEntries(sessionId: string, entries: TranscriptEntryRecord[]): void {
  if (entries.length === 0) {
    return;
  }

  ensureConfigDirs();
  const filePath = sessionPath(sessionId);
  const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
  appendFileSync(filePath, serialized + "\n", "utf-8");
}

/** Append a structured sub-agent run record to the session file */
export function appendSubAgentRunRecord(
  sessionId: string,
  record: Omit<SubAgentRunRecord, "_type" | "sessionId" | "createdAt" | "childId"> & {
    childId?: string;
    id?: string;
    sessionId?: string;
    createdAt?: string;
  },
): void {
  ensureConfigDirs();
  const filePath = sessionPath(sessionId);
  const serialized = JSON.stringify(
    createSubAgentRunRecord({
      ...record,
      sessionId,
    }),
  );
  appendFileSync(filePath, serialized + "\n", "utf-8");
}

/** Public alias matching the v2 API name */
export const saveSubAgentRun = appendSubAgentRunRecord;

/** Backward-compatible alias for older callers/tests */
export const appendChildExecutionRecord = appendSubAgentRunRecord;

/** Append a structured plan run record to the session file */
export function appendPlanRunRecord(
  sessionId: string,
  record: Omit<PlanRunRecord, "_type" | "sessionId" | "createdAt" | "planRunId"> & {
    planRunId?: string;
    id?: string;
    sessionId?: string;
    createdAt?: string;
  },
): void {
  ensureConfigDirs();
  const filePath = sessionPath(sessionId);
  const serialized = JSON.stringify(
    createPlanRunRecord({
      ...record,
      sessionId,
    }),
  );
  appendFileSync(filePath, serialized + "\n", "utf-8");
}

/** Public alias matching the v2 API name */
export const savePlanRun = appendPlanRunRecord;

/** Append an optional agent trace record to the session file. */
export function appendAgentTraceRecord(
  sessionId: string,
  record: Omit<AgentTraceRecord, "_type" | "sessionId" | "timestamp" | "traceId"> & {
    traceId?: string;
    id?: string;
    sessionId?: string;
    timestamp?: string;
  },
): void {
  ensureConfigDirs();
  const filePath = sessionPath(sessionId);
  const serialized = JSON.stringify(
    createAgentTraceRecord({
      ...record,
      sessionId,
    }),
  );
  appendFileSync(filePath, serialized + "\n", "utf-8");
}

/** Public alias for reliability trace persistence. */
export const saveAgentTrace = appendAgentTraceRecord;

/** Write session metadata header (first line) */
export function writeSessionHeader(sessionId: string, metadata: Record<string, unknown>): void {
  ensureConfigDirs();
  const filePath = sessionPath(sessionId);
  const header = JSON.stringify(createSessionHeaderRecord(sessionId, metadata));
  writeFileSync(filePath, header + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Load all messages from a session */
export function loadSession(sessionId: string): SessionData | null {
  const filePath = sessionPath(sessionId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const messages: ChatMessage[] = [];
    const subAgentRuns: SubAgentRunRecord[] = [];
    const planRuns: PlanRunRecord[] = [];
    const agentTraces: AgentTraceRecord[] = [];

    for (const line of lines) {
      const parsed = parseSessionLine(line);
      if (parsed.kind === "message") {
        messages.push(parsed.message);
      } else if (parsed.kind === "structured") {
        if (parsed.record._type === "sub_agent_run") {
          subAgentRuns.push(parsed.record);
        } else if (parsed.record._type === "plan_run") {
          planRuns.push(parsed.record);
        } else if (parsed.record._type === "agent_trace") {
          agentTraces.push(parsed.record);
        }
      } else {
        console.error(`[session] Skipping malformed line in ${sessionId}: ${line.slice(0, 80)}`);
      }
    }

    return { id: sessionId, messages, subAgentRuns, planRuns: dedupePlanRuns(planRuns), agentTraces, childExecutions: subAgentRuns };
  } catch {
    return null;
  }
}

/** Load only sub-agent run records from a session */
export function loadSubAgentRuns(sessionId: string): SubAgentRunRecord[] {
  const runs = loadSession(sessionId)?.subAgentRuns ?? [];
  return runs
    .slice()
    .sort((a, b) => {
      const timeA = Date.parse(a.createdAt);
      const timeB = Date.parse(b.createdAt);
      if (Number.isNaN(timeA) && Number.isNaN(timeB)) return 0;
      if (Number.isNaN(timeA)) return 1;
      if (Number.isNaN(timeB)) return -1;
      if (timeA !== timeB) return timeA - timeB;
      return a.childId.localeCompare(b.childId);
    })
    .map((record) => formatSubAgentRunForDisplay(record));
}

/** Load only plan run records from a session */
export function loadPlanRuns(sessionId: string): PlanRunRecord[] {
  return loadSession(sessionId)?.planRuns ?? [];
}

/** Load only reliability trace records from a session. */
export function loadAgentTraceRecords(sessionId: string): AgentTraceRecord[] {
  return loadSession(sessionId)?.agentTraces ?? [];
}

export function loadLatestResumablePlanRun(sessionId: string): PlanRunRecord | null {
  const candidates = loadPlanRuns(sessionId)
    .filter((record) =>
      (record.mode === "goal" || record.mode === "autopilot" || record.mode === undefined)
      && record.resumeEligible !== false
      && (
        record.status === "running"
        || record.status === "failed"
        || record.status === "aborted"
        || record.status === "blocked"
        || record.status === "needs_user"
      ),
    )
    .sort((a, b) => toSortableTime(b.createdAt) - toSortableTime(a.createdAt));

  return candidates[0] ?? null;
}

/** Backward-compatible alias for older callers/tests */
export const loadChildExecutionRecords = loadSubAgentRuns;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** List all sessions, newest first */
export function listSessions(): SessionInfo[] {
  ensureConfigDirs();

  try {
    const files = readdirSync(paths.sessionsDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => {
        const filePath = join(paths.sessionsDir, f);
        const id = f.replace(".jsonl", "");
        const stat = statSync(filePath);
        const raw = readFileSync(filePath, "utf-8");
        const lineCount = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((line) => parseSessionLine(line).kind === "message").length;

        return {
          id,
          filePath,
          createdAt: stat.birthtime,
          messageCount: lineCount,
        };
      });

    // Sort newest first
    files.sort((a: SessionInfo, b: SessionInfo) => b.createdAt.getTime() - a.createdAt.getTime());
    return files;
  } catch {
    return [];
  }
}

/** Get the most recent session ID */
export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  return sessions[0]?.id ?? null;
}

export type {
  ChildExecutionRecord,
  SessionHeaderRecord,
  SubAgentRunRecord,
} from "./records.js";
