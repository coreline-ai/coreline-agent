import type {
  ParallelAgentTaskRecord,
  ParallelAgentTaskStatus,
} from "./types.js";
import { isParallelAgentTerminalStatus } from "./types.js";

export interface ParallelAgentTaskCollectionSummary {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  blocked: number;
  running: number;
  pending: number;
  timeout: number;
  aborted: number;
  lines: string[];
}

export interface ParallelAgentBoundaryWarning {
  kind: "changed_non_owned" | "changed_outside_owned" | "read_untracked";
  path: string;
  message: string;
}

function trimOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function summarizeStatus(status: ParallelAgentTaskStatus): "completed" | "partial" | "failed" | "blocked" | "running" | "pending" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
    case "timeout":
      return "blocked";
    case "pending":
      return "pending";
    case "running":
    default:
      return "running";
  }
}

function normalizePathForBoundary(value: string): string {
  return value.trim().replace(/^[./]+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

function uniqueNormalizedPaths(values: readonly string[] | undefined): string[] {
  if (!values?.length) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePathForBoundary(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function pathMatchesBoundary(path: string, boundary: string): boolean {
  const normalizedPath = normalizePathForBoundary(path);
  const normalizedBoundary = normalizePathForBoundary(boundary);
  return normalizedPath === normalizedBoundary || normalizedPath.startsWith(`${normalizedBoundary}/`);
}

function pathMatchesAny(path: string, boundaries: readonly string[]): boolean {
  return boundaries.some((boundary) => pathMatchesBoundary(path, boundary));
}

export function detectParallelAgentBoundaryWarnings(record: ParallelAgentTaskRecord): ParallelAgentBoundaryWarning[] {
  const structured = record.structuredResult;
  if (!structured) {
    return [];
  }

  const ownedPaths = uniqueNormalizedPaths(record.ownedPaths);
  const nonOwnedPaths = uniqueNormalizedPaths(record.nonOwnedPaths);
  const changedFiles = uniqueNormalizedPaths(structured.changedFiles);
  const readFiles = uniqueNormalizedPaths(structured.readFiles);
  const warnings: ParallelAgentBoundaryWarning[] = [];

  for (const file of changedFiles) {
    if (nonOwnedPaths.length > 0 && pathMatchesAny(file, nonOwnedPaths)) {
      warnings.push({
        kind: "changed_non_owned",
        path: file,
        message: `changed non-owned path: ${file}`,
      });
      continue;
    }

    if (ownedPaths.length > 0 && !pathMatchesAny(file, ownedPaths)) {
      warnings.push({
        kind: "changed_outside_owned",
        path: file,
        message: `changed outside owned paths: ${file}`,
      });
    }
  }

  for (const file of readFiles) {
    if (ownedPaths.length > 0 && nonOwnedPaths.length > 0 && !pathMatchesAny(file, ownedPaths) && !pathMatchesAny(file, nonOwnedPaths)) {
      warnings.push({
        kind: "read_untracked",
        path: file,
        message: `read path outside declared owned/non-owned boundaries: ${file}`,
      });
    }
  }

  return warnings;
}

export function escapeChildResultText(text: string): string {
  return text
    .replace(/<\/(?:system|developer|assistant|user|tool)>/gi, (match) => match.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/<(?:system|developer|assistant|user|tool)>/gi, (match) => match.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/ignore\s+previous\s+instructions/gi, "[redacted instruction]")
    .replace(/disregard\s+previous\s+instructions/gi, "[redacted instruction]")
    .replace(/system\s+prompt/gi, "[redacted instruction]")
    .replace(/developer\s+message/gi, "[redacted instruction]")
    .replace(/<\s*\/?\s*system\s*>/gi, "[redacted instruction]")
    .replace(/<\s*\/?\s*developer\s*>/gi, "[redacted instruction]")
    .replace(/<\s*\/?\s*assistant\s*>/gi, "[redacted instruction]")
    .replace(/<\s*\/?\s*user\s*>/gi, "[redacted instruction]")
    .replace(/<\s*\/?\s*tool\s*>/gi, "[redacted instruction]")
    .replace(/```/g, "ˋˋˋ");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function wrapParallelAgentChildResult(params: {
  id: string;
  status: string;
  body: string;
}): string {
  const safeId = escapeAttribute(params.id);
  const safeStatus = escapeAttribute(params.status);
  const safeBody = escapeChildResultText(params.body);
  return `[CHILD_RESULT id=${safeId} status=${safeStatus}]${safeBody}[/CHILD_RESULT]`;
}

export function formatParallelAgentTaskSummary(record: ParallelAgentTaskRecord): string {
  const state = record.structuredResult?.status ?? summarizeStatus(record.status);
  const summary = trimOrFallback(
    record.structuredResult?.summary
      ?? record.summary
      ?? record.finalText
      ?? record.error,
    "(no summary)",
  );

  const warnings = detectParallelAgentBoundaryWarnings(record);
  const suffix = warnings.length > 0 ? ` • warnings=${warnings.length}` : "";
  return `${state} • ${summary}${suffix}`;
}

export function formatParallelAgentTaskResult(record: ParallelAgentTaskRecord): string {
  const status = record.structuredResult?.status ?? summarizeStatus(record.status);
  const summary = trimOrFallback(record.structuredResult?.summary ?? record.summary ?? record.finalText ?? record.error, "(no summary)");
  const finalText = trimOrFallback(record.finalText ?? record.structuredResult?.summary ?? record.summary ?? record.error, summary);
  const body = [
    `status: ${status}`,
    `summary: ${summary}`,
    `final_text: ${finalText || summary || "(no final text)"}`,
    detectParallelAgentBoundaryWarnings(record).length > 0 ? "boundary_warnings:" : undefined,
    ...detectParallelAgentBoundaryWarnings(record).map((warning) => `- ${warning.kind}: ${warning.message}`),
    record.error ? `error: ${record.error}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");

  return wrapParallelAgentChildResult({
    id: record.id,
    status,
    body,
  });
}

export function collectParallelAgentTaskSummaries(
  records: Iterable<ParallelAgentTaskRecord>,
): ParallelAgentTaskCollectionSummary {
  const lines: string[] = [];
  let total = 0;
  let completed = 0;
  let partial = 0;
  let failed = 0;
  let blocked = 0;
  let running = 0;
  let pending = 0;
  let timeout = 0;
  let aborted = 0;

  for (const record of records) {
    total += 1;
    const state = record.structuredResult?.status ?? summarizeStatus(record.status);
    switch (state) {
      case "completed":
        completed += 1;
        break;
      case "partial":
        partial += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
      case "running":
        running += 1;
        break;
      case "pending":
        pending += 1;
        break;
    }

    if (record.status === "timeout") {
      timeout += 1;
    }
    if (record.status === "aborted") {
      aborted += 1;
    }

    lines.push(`${record.id}: ${formatParallelAgentTaskSummary(record)}`);
  }

  return {
    total,
    completed,
    partial,
    failed,
    blocked,
    running,
    pending,
    timeout,
    aborted,
    lines,
  };
}

export function formatParallelAgentTaskCollection(records: Iterable<ParallelAgentTaskRecord>): string {
  const summary = collectParallelAgentTaskSummaries(records);
  const lines = [
    `tasks: ${summary.total}`,
    `completed: ${summary.completed}`,
    `partial: ${summary.partial}`,
    `failed: ${summary.failed}`,
    `blocked: ${summary.blocked}`,
    `running: ${summary.running}`,
    `pending: ${summary.pending}`,
  ];

  if (summary.timeout > 0) {
    lines.push(`timeout: ${summary.timeout}`);
  }

  if (summary.aborted > 0) {
    lines.push(`aborted: ${summary.aborted}`);
  }

  if (summary.lines.length > 0) {
    lines.push("", ...summary.lines);
  }

  return lines.join("\n");
}

export function formatParallelAgentTaskBlock(record: ParallelAgentTaskRecord): string {
  return formatParallelAgentTaskResult(record);
}

export function isTerminalSummaryRecord(record: ParallelAgentTaskRecord): boolean {
  return isParallelAgentTerminalStatus(record.status);
}
