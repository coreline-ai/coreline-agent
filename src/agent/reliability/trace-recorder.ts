import { randomUUID } from "node:crypto";
import type { AgentTraceEvent, AgentTraceRecord } from "./types.js";

export type TraceSink = (record: AgentTraceRecord) => void | Promise<void>;

export const TRACE_METADATA_MAX_STRING_LENGTH = 240;
export const TRACE_METADATA_MAX_DEPTH = 4;
export const TRACE_METADATA_MAX_ARRAY_ITEMS = 20;
export const TRACE_METADATA_MAX_OBJECT_KEYS = 40;

const REDACTED = "[REDACTED]";
const OMITTED_RAW_CONTENT = "[omitted:raw-content]";

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|authorization|auth[_-]?header|bearer)/i;
const RAW_CONTENT_KEY_PATTERN = /(^prompt$|raw[_-]?prompt|file[_-]?content|full[_-]?(output|stdout|stderr)|command[_-]?output|raw[_-]?(output|stdout|stderr)|content$)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|ak|ghp|gho|ghu|ghs|github_pat|xox[baprs])-[A-Za-z0-9_\-]{10,}\b/g,
  /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{10,}\b/gi,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{8,}@/g,
];

function truncateString(value: string, maxLength = TRACE_METADATA_MAX_STRING_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  const marker = `…[truncated ${value.length - maxLength} chars]…`;
  const remaining = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

export function redactSensitiveText(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(redactSensitiveText(value));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (depth >= TRACE_METADATA_MAX_DEPTH) {
      return "[truncated:max-depth]";
    }

    const items = value
      .slice(0, TRACE_METADATA_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeValue(entry, depth + 1));
    if (value.length > TRACE_METADATA_MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - TRACE_METADATA_MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (depth >= TRACE_METADATA_MAX_DEPTH) {
      return "[truncated:max-depth]";
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, TRACE_METADATA_MAX_OBJECT_KEYS);
    for (const [key, raw] of entries) {
      if (SECRET_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
        continue;
      }

      if (RAW_CONTENT_KEY_PATTERN.test(key)) {
        result[key] = OMITTED_RAW_CONTENT;
        continue;
      }

      result[key] = sanitizeValue(raw, depth + 1);
    }

    const originalKeyCount = Object.keys(value as Record<string, unknown>).length;
    if (originalKeyCount > TRACE_METADATA_MAX_OBJECT_KEYS) {
      result.__truncatedKeys = originalKeyCount - TRACE_METADATA_MAX_OBJECT_KEYS;
    }
    return result;
  }

  return String(value);
}

export function sanitizeTraceMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized = sanitizeValue(metadata, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : undefined;
}

export function createAgentTraceRecord(sessionId: string, event: AgentTraceEvent): AgentTraceRecord {
  return {
    _type: "agent_trace",
    traceId: randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    eventKind: event.eventKind,
    reason: event.reason ? truncateString(redactSensitiveText(event.reason)) : undefined,
    toolName: event.toolName ? truncateString(redactSensitiveText(event.toolName)) : undefined,
    toolUseId: event.toolUseId ? truncateString(redactSensitiveText(event.toolUseId)) : undefined,
    outcome: event.outcome ? truncateString(redactSensitiveText(event.outcome)) : undefined,
    metadata: sanitizeTraceMetadata(event.metadata),
  };
}

export interface TraceRecorder {
  recordTrace(event: AgentTraceEvent): AgentTraceRecord | Promise<AgentTraceRecord>;
}

export function createTraceRecorder(sessionId: string, sink: TraceSink): TraceRecorder {
  return {
    recordTrace(event: AgentTraceEvent): AgentTraceRecord | Promise<AgentTraceRecord> {
      const record = createAgentTraceRecord(sessionId, event);
      const result = sink(record);
      if (result && typeof (result as Promise<void>).then === "function") {
        return (result as Promise<void>).then(() => record);
      }
      return record;
    },
  };
}
