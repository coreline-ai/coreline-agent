/**
 * Session export — pure formatters for saved sessions.
 *
 * This module reads persisted session data and renders human-readable
 * Markdown, plain text, or PR-description drafts without touching CLI/TUI.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import type { ChatMessage, ContentBlock } from "../agent/types.js";
import type { AgentTraceRecord } from "../agent/reliability/types.js";
import type { PlanRunRecord, SubAgentRunRecord, SessionHeaderRecord } from "./records.js";
import type { ParallelAgentRegistrySnapshot, ParallelAgentTaskRecord } from "../agent/parallel/types.js";
import { loadSession } from "./storage.js";
import { parseSessionLine } from "./records.js";

export interface SessionExportOptions {
  maxContentLength?: number;
  maxListItems?: number;
  /** Optional in-memory background task evidence. Export keeps summaries only, never raw child transcripts. */
  parallelTasks?: ParallelAgentTaskRecord[] | ParallelAgentRegistrySnapshot;
}

class SessionExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExportError";
  }
}

interface SessionExportData {
  sessionId: string;
  header: SessionHeaderRecord | null;
  messages: ChatMessage[];
  subAgentRuns: SubAgentRunRecord[];
  planRuns: PlanRunRecord[];
  agentTraces: AgentTraceRecord[];
  parallelTasks: ParallelAgentTaskRecord[];
}

type OutputStyle = "markdown" | "text";

const DEFAULT_MAX_CONTENT_LENGTH = 900;
const DEFAULT_MAX_LIST_ITEMS = 8;
const PARALLEL_FINAL_TEXT_EXPORT_LIMIT = 180;

function getSessionPath(sessionId: string): string {
  return join(paths.sessionsDir, `${sessionId}.jsonl`);
}

function toIsoOrNull(value?: string): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
}

function escapeFence(value: string): string {
  return value.replace(/```/g, "`\u200b``");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringifyInline(value: unknown, maxLength: number): string {
  if (typeof value === "string") {
    return truncateText(normalizeWhitespace(value), maxLength);
  }

  try {
    return truncateText(JSON.stringify(value), maxLength);
  } catch {
    return "[unserializable]";
  }
}

function readSessionHeader(sessionId: string): SessionHeaderRecord | null {
  const filePath = getSessionPath(sessionId);
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, "utf-8");
  const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return null;
  }

  const parsed = parseSessionLine(firstLine);
  if (parsed.kind !== "structured" || parsed.record._type !== "session_header") {
    return null;
  }

  return parsed.record;
}

function normalizeParallelTasks(input?: ParallelAgentTaskRecord[] | ParallelAgentRegistrySnapshot): ParallelAgentTaskRecord[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return Array.isArray(input.tasks) ? input.tasks : [];
}

function loadExportData(sessionId: string, options: SessionExportOptions = {}): SessionExportData | null {
  const loaded = loadSession(sessionId);
  if (!loaded) {
    return null;
  }

  return {
    sessionId,
    header: readSessionHeader(sessionId),
    messages: loaded.messages,
    subAgentRuns: loaded.subAgentRuns,
    planRuns: loaded.planRuns,
    agentTraces: loaded.agentTraces,
    parallelTasks: normalizeParallelTasks(options.parallelTasks),
  };
}

function assertExportable(data: SessionExportData | null, sessionId: string): asserts data is SessionExportData {
  if (!data) {
    throw new SessionExportError(`세션 '${sessionId}' 을(를) 찾을 수 없습니다.`);
  }

  const hasContent = data.messages.length > 0
    || data.subAgentRuns.length > 0
    || data.planRuns.length > 0
    || data.agentTraces.length > 0
    || data.parallelTasks.length > 0;

  if (!hasContent) {
    throw new SessionExportError(`세션 '${sessionId}' 에 내보낼 내용이 없습니다.`);
  }
}

function getModeLabel(style: OutputStyle, title: string, level: number): string {
  if (style === "markdown") {
    return `${"#".repeat(level)} ${title}`;
  }

  return `${"=".repeat(Math.max(3, title.length + level))} ${title} ${"=".repeat(Math.max(3, title.length + level))}`;
}

function getSubLabel(style: OutputStyle, label: string): string {
  return style === "markdown" ? `**${label}**` : label;
}

function formatKeyValue(style: OutputStyle, label: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  return style === "markdown"
    ? `- ${label}: ${value}`
    : `${label}: ${value}`;
}

function formatCodeBlock(style: OutputStyle, language: string, value: string): string[] {
  if (style === "markdown") {
    return [
      `\`\`\`${language}`,
      escapeFence(value),
      "```",
    ];
  }

  return value.split("\n").map((line) => `  ${line}`);
}

function summarizeContentBlock(block: ContentBlock, maxLength: number): string[] {
  if (block.type === "text") {
    return [truncateText(block.text, maxLength)];
  }

  if (block.type === "image") {
    return [`[image: ${block.mediaType}]`];
  }

  if (block.type === "tool_use") {
    return [
      `[tool use] ${block.name} (${block.id})`,
      `input: ${stringifyInline(block.input, maxLength)}`,
    ];
  }

  const content = truncateText(block.content, maxLength);
  return [
    `[tool result] ${block.toolUseId}${block.isError ? " (error)" : ""}`,
    content,
  ];
}

function summarizeMessage(message: ChatMessage, maxLength: number): string[] {
  if (typeof message.content === "string") {
    return [truncateText(message.content, maxLength)];
  }

  const lines: string[] = [];
  for (const block of message.content) {
    lines.push(...summarizeContentBlock(block, maxLength));
  }

  return lines.length > 0 ? lines : ["(empty message)"];
}

function summarizeSubAgentRun(run: SubAgentRunRecord, maxLength: number): string[] {
  const lines: string[] = [];
  lines.push(`- childId: ${run.childId}`);
  lines.push(`  status: ${run.status ?? "completed"}`);
  if (run.resultKind) {
    lines.push(`  kind: ${run.resultKind}`);
  }
  if (run.providerName || run.model) {
    lines.push(`  provider: ${[run.providerName, run.model].filter(Boolean).join(" / ")}`);
  }
  if (run.turns !== undefined) {
    lines.push(`  turns: ${run.turns}`);
  }
  if (run.usedTools && run.usedTools.length > 0) {
    lines.push(`  tools: ${run.usedTools.join(", ")}`);
  }
  if (run.summary) {
    lines.push(`  summary: ${truncateText(normalizeWhitespace(run.summary), maxLength)}`);
  }
  if (run.finalText) {
    lines.push(`  final_text: ${truncateText(normalizeWhitespace(run.finalText), maxLength)}`);
  }
  if (run.error) {
    lines.push(`  error: ${truncateText(normalizeWhitespace(run.error), maxLength)}`);
  }

  return lines;
}

function summarizePlanRun(run: PlanRunRecord, maxLength: number): string[] {
  const lines: string[] = [];
  lines.push(`- planRunId: ${run.planRunId}`);
  lines.push(`  goal: ${truncateText(normalizeWhitespace(run.goal), maxLength)}`);
  lines.push(`  status: ${run.status ?? (run.completed ? "completed" : "running")}`);
  if (run.mode) lines.push(`  mode: ${run.mode}`);
  if (run.source) lines.push(`  source: ${run.source}`);
  if (run.providerName || run.model) lines.push(`  provider: ${[run.providerName, run.model].filter(Boolean).join(" / ")}`);
  if (run.summary) {
    lines.push(
      `  summary: completed=${run.summary.completed}, failed=${run.summary.failed}, ambiguous=${run.summary.ambiguous}${run.summary.verified !== undefined ? `, verified=${run.summary.verified}` : ""}`,
    );
  }
  if (run.resultText) lines.push(`  result: ${truncateText(normalizeWhitespace(run.resultText), maxLength)}`);
  if (run.error) lines.push(`  error: ${truncateText(normalizeWhitespace(run.error), maxLength)}`);
  if (run.lastVerificationSummary) lines.push(`  verification: ${truncateText(normalizeWhitespace(run.lastVerificationSummary), maxLength)}`);
  return lines;
}

function summarizeTrace(trace: AgentTraceRecord, maxLength: number): string[] {
  const lines: string[] = [];
  lines.push(`- ${trace.eventKind}`);
  lines.push(`  traceId: ${trace.traceId}`);
  if (trace.reason) lines.push(`  reason: ${truncateText(normalizeWhitespace(trace.reason), maxLength)}`);
  if (trace.toolName) lines.push(`  tool: ${trace.toolName}`);
  if (trace.toolUseId) lines.push(`  toolUseId: ${trace.toolUseId}`);
  if (trace.outcome) lines.push(`  outcome: ${trace.outcome}`);
  return lines;
}

function getParallelTaskSummary(task: ParallelAgentTaskRecord, maxLength: number): string {
  const summary = task.structuredResult?.summary ?? task.summary ?? task.error;
  if (summary) {
    return truncateText(normalizeWhitespace(summary), maxLength);
  }

  if (task.finalText) {
    return `finalText captured (${Math.min(task.finalText.length, PARALLEL_FINAL_TEXT_EXPORT_LIMIT)} chars preview omitted; use /agent read ${task.id})`;
  }

  return "(no summary)";
}

function getParallelTaskEvidenceLines(task: ParallelAgentTaskRecord, maxLength: number): string[] {
  const lines: string[] = [];
  const result = task.structuredResult;
  if (result?.changedFiles?.length) {
    lines.push(`  changedFiles: ${truncateText(result.changedFiles.join(", "), maxLength)}`);
  }
  if (result?.readFiles?.length) {
    lines.push(`  readFiles: ${truncateText(result.readFiles.join(", "), maxLength)}`);
  }
  if (result?.commandsRun?.length) {
    lines.push(`  commands: ${truncateText(result.commandsRun.join("; "), maxLength)}`);
  }
  if (result?.testsRun?.length) {
    const tests = result.testsRun.map((test) => `${test.command}=${test.status}`).join("; ");
    lines.push(`  tests: ${truncateText(tests, maxLength)}`);
  }
  if (result?.risks?.length) {
    lines.push(`  risks: ${truncateText(result.risks.join("; "), maxLength)}`);
  }
  if (task.usedTools?.length) {
    lines.push(`  tools: ${truncateText(task.usedTools.join(", "), maxLength)}`);
  }
  if (task.finalText && !task.summary && !task.structuredResult?.summary) {
    lines.push(`  finalText: omitted from export; use /agent read ${task.id}`);
  }
  return lines;
}

function summarizeParallelTask(task: ParallelAgentTaskRecord, maxLength: number): string[] {
  const lines: string[] = [];
  lines.push(`- taskId: ${task.id}`);
  lines.push(`  status: ${task.status}`);
  if (task.description) lines.push(`  description: ${truncateText(normalizeWhitespace(task.description), maxLength)}`);
  if (task.structuredResult?.status) lines.push(`  resultStatus: ${task.structuredResult.status}`);
  lines.push(`  summary: ${getParallelTaskSummary(task, maxLength)}`);
  if (task.write) lines.push(`  write: true`);
  if (task.ownedPaths?.length) lines.push(`  ownedPaths: ${truncateText(task.ownedPaths.join(", "), maxLength)}`);
  lines.push(...getParallelTaskEvidenceLines(task, maxLength));
  if (task.error) lines.push(`  error: ${truncateText(normalizeWhitespace(task.error), maxLength)}`);
  return lines;
}

function summarizeParallelTaskCompact(task: ParallelAgentTaskRecord, maxLength: number): string {
  const state = task.structuredResult?.status ?? task.status;
  return `${task.id}: ${state} — ${getParallelTaskSummary(task, maxLength)}`;
}

function isVerificationParallelTask(task: ParallelAgentTaskRecord): boolean {
  const haystack = [task.description, task.summary, task.structuredResult?.summary, ...(task.structuredResult?.commandsRun ?? [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /\b(verify|verification|typecheck|build|test|lint)\b/.test(haystack)
    || Boolean(task.structuredResult?.testsRun?.length);
}

function collectMetadataLines(data: SessionExportData, style: OutputStyle): string[] {
  const header = data.header;
  const counts = [
    formatKeyValue(style, "Messages", data.messages.length),
    formatKeyValue(style, "Plan runs", data.planRuns.length),
    formatKeyValue(style, "Sub-agent runs", data.subAgentRuns.length),
    formatKeyValue(style, "Traces", data.agentTraces.length),
    formatKeyValue(style, "Parallel agent tasks", data.parallelTasks.length),
  ].filter(Boolean);

  const lines: string[] = [];
  lines.push(formatKeyValue(style, "Session ID", data.sessionId));
  if (header?.provider) lines.push(formatKeyValue(style, "Provider", header.provider));
  if (header?.model) lines.push(formatKeyValue(style, "Model", header.model));
  if (header?.cwd) lines.push(formatKeyValue(style, "CWD", header.cwd));
  if (header?.createdAt) lines.push(formatKeyValue(style, "Created", toIsoOrNull(header.createdAt) ?? header.createdAt));

  const latestPlan = data.planRuns[data.planRuns.length - 1];
  const latestSubAgent = data.subAgentRuns[data.subAgentRuns.length - 1];
  const latestTrace = data.agentTraces[data.agentTraces.length - 1];
  const lastTouched = [latestPlan?.createdAt, latestSubAgent?.createdAt, latestTrace?.timestamp]
    .map(toIsoOrNull)
    .find(Boolean);
  if (lastTouched) {
    lines.push(formatKeyValue(style, "Last activity", lastTouched));
  }
  lines.push(...counts);
  return lines.filter(Boolean);
}

function renderMessageSection(data: SessionExportData, style: OutputStyle, maxContentLength: number): string[] {
  const lines: string[] = [];
  lines.push(getModeLabel(style, "Conversation", 2));

  data.messages.forEach((message, index) => {
    const turnLabel = style === "markdown"
      ? `### Turn ${index + 1} — ${message.role}`
      : `Turn ${index + 1} [${message.role}]`;
    lines.push(turnLabel);
    lines.push(...formatCodeBlock(style, "text", summarizeMessage(message, maxContentLength).join("\n")));
    lines.push("");
  });

  if (data.messages.length === 0) {
    lines.push(style === "markdown" ? "_No chat messages found._" : "No chat messages found.");
  }

  return lines;
}

function renderPlanRunsSection(data: SessionExportData, style: OutputStyle, maxContentLength: number, maxItems: number): string[] {
  const lines: string[] = [];
  lines.push(getModeLabel(style, "Plan Runs", 2));

  if (data.planRuns.length === 0) {
    lines.push(style === "markdown" ? "_No plan runs found._" : "No plan runs found.");
    return lines;
  }

  data.planRuns.slice(0, maxItems).forEach((run) => {
    lines.push(...summarizePlanRun(run, maxContentLength));
    lines.push("");
  });

  if (data.planRuns.length > maxItems) {
    lines.push(style === "markdown"
      ? `_... ${data.planRuns.length - maxItems} more plan runs omitted ..._`
      : `... ${data.planRuns.length - maxItems} more plan runs omitted ...`);
  }

  return lines;
}

function renderSubAgentRunsSection(data: SessionExportData, style: OutputStyle, maxContentLength: number, maxItems: number): string[] {
  const lines: string[] = [];
  lines.push(getModeLabel(style, "Sub-agent Runs", 2));

  if (data.subAgentRuns.length === 0) {
    lines.push(style === "markdown" ? "_No sub-agent runs found._" : "No sub-agent runs found.");
    return lines;
  }

  data.subAgentRuns.slice(0, maxItems).forEach((run) => {
    lines.push(...summarizeSubAgentRun(run, maxContentLength));
    lines.push("");
  });

  if (data.subAgentRuns.length > maxItems) {
    lines.push(style === "markdown"
      ? `_... ${data.subAgentRuns.length - maxItems} more sub-agent runs omitted ..._`
      : `... ${data.subAgentRuns.length - maxItems} more sub-agent runs omitted ...`);
  }

  return lines;
}

function renderParallelAgentTasksSection(data: SessionExportData, style: OutputStyle, maxContentLength: number, maxItems: number): string[] {
  const lines: string[] = [];
  lines.push(getModeLabel(style, "Parallel Agent Tasks", 2));

  if (data.parallelTasks.length === 0) {
    lines.push(style === "markdown" ? "_No parallel agent tasks provided._" : "No parallel agent tasks provided.");
    return lines;
  }

  const tasks = data.parallelTasks.slice(0, maxItems);
  if (style === "text") {
    const counts = tasks.reduce<Record<string, number>>((acc, task) => {
      const key = task.status;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    lines.push(`tasks: ${data.parallelTasks.length}`);
    lines.push(`status: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(", ")}`);
    tasks.forEach((task) => lines.push(`- ${summarizeParallelTaskCompact(task, maxContentLength)}`));
  } else {
    tasks.forEach((task) => {
      lines.push(...summarizeParallelTask(task, maxContentLength));
      lines.push("");
    });
  }

  if (data.parallelTasks.length > maxItems) {
    lines.push(style === "markdown"
      ? `_... ${data.parallelTasks.length - maxItems} more parallel agent tasks omitted ..._`
      : `... ${data.parallelTasks.length - maxItems} more parallel agent tasks omitted ...`);
  }

  return lines;
}

function renderTraceSection(data: SessionExportData, style: OutputStyle, maxContentLength: number, maxItems: number): string[] {
  const lines: string[] = [];
  lines.push(getModeLabel(style, "Traces", 2));

  if (data.agentTraces.length === 0) {
    lines.push(style === "markdown" ? "_No trace records found._" : "No trace records found.");
    return lines;
  }

  data.agentTraces.slice(0, maxItems).forEach((trace) => {
    lines.push(...summarizeTrace(trace, maxContentLength));
    lines.push("");
  });

  if (data.agentTraces.length > maxItems) {
    lines.push(style === "markdown"
      ? `_... ${data.agentTraces.length - maxItems} more trace records omitted ..._`
      : `... ${data.agentTraces.length - maxItems} more trace records omitted ...`);
  }

  return lines;
}

function renderSummaryIntro(data: SessionExportData, style: OutputStyle): string[] {
  const lines: string[] = [];
  lines.push(getModeLabel(style, "Summary", 2));
  lines.push(...collectMetadataLines(data, style));
  return lines;
}

function renderSessionDocument(data: SessionExportData, style: OutputStyle, options: SessionExportOptions = {}): string {
  const maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  const maxItems = options.maxListItems ?? DEFAULT_MAX_LIST_ITEMS;
  const lines: string[] = [];

  lines.push(getModeLabel(style, "Session Export", 1));
  lines.push("");
  lines.push(...renderSummaryIntro(data, style));
  lines.push("");
  lines.push(...renderMessageSection(data, style, maxContentLength));
  lines.push("");
  lines.push(...renderPlanRunsSection(data, style, maxContentLength, maxItems));
  lines.push("");
  lines.push(...renderSubAgentRunsSection(data, style, maxContentLength, maxItems));
  lines.push("");
  lines.push(...renderParallelAgentTasksSection(data, style, maxContentLength, maxItems));
  lines.push("");
  lines.push(...renderTraceSection(data, style, maxContentLength, maxItems));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function renderPrDescription(data: SessionExportData, options: SessionExportOptions = {}): string {
  const maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  const maxItems = options.maxListItems ?? DEFAULT_MAX_LIST_ITEMS;
  const lines: string[] = [];

  lines.push("# Session Export PR Draft");
  lines.push("");
  lines.push("## Summary");
  lines.push(...collectMetadataLines(data, "markdown"));
  lines.push("");

  lines.push("## Changes");
  if (data.planRuns.length > 0) {
    lines.push(`- Plan runs: ${data.planRuns.length}`);
    data.planRuns.slice(0, maxItems).forEach((run) => {
      lines.push(`  - ${run.planRunId}: ${truncateText(normalizeWhitespace(run.goal), maxContentLength)}`);
    });
  } else {
    lines.push("- Plan runs: none");
  }

  if (data.subAgentRuns.length > 0) {
    lines.push(`- Sub-agent runs: ${data.subAgentRuns.length}`);
    data.subAgentRuns.slice(0, maxItems).forEach((run) => {
      const summary = run.summary ?? run.finalText ?? "(no summary)";
      lines.push(`  - ${run.childId}: ${truncateText(normalizeWhitespace(summary), maxContentLength)}`);
    });
  } else {
    lines.push("- Sub-agent runs: none");
  }

  if (data.parallelTasks.length > 0) {
    lines.push(`- Parallel agent tasks: ${data.parallelTasks.length}`);
    data.parallelTasks.slice(0, maxItems).forEach((task) => {
      lines.push(`  - ${task.id}: ${task.status} — ${getParallelTaskSummary(task, maxContentLength)}`);
    });
  } else {
    lines.push("- Parallel agent tasks: none");
  }

  if (data.messages.length > 0) {
    lines.push(`- Messages: ${data.messages.length}`);
    const firstMessage = data.messages[0];
    const lastMessage = data.messages[data.messages.length - 1];
    lines.push(`  - First: ${truncateText(normalizeWhitespace(summarizeMessage(firstMessage, maxContentLength).join(" ")), maxContentLength)}`);
    lines.push(`  - Last: ${truncateText(normalizeWhitespace(summarizeMessage(lastMessage, maxContentLength).join(" ")), maxContentLength)}`);
  } else {
    lines.push("- Messages: none");
  }

  lines.push("");
  lines.push("## Verification");
  if (data.agentTraces.length > 0) {
    lines.push(`- Trace records: ${data.agentTraces.length}`);
    const recentTrace = data.agentTraces[data.agentTraces.length - 1];
    lines.push(`- Latest trace: ${recentTrace.eventKind}${recentTrace.reason ? ` — ${truncateText(normalizeWhitespace(recentTrace.reason), maxContentLength)}` : ""}`);
  } else {
    lines.push("- Trace records: none");
  }

  const verifiedPlanRuns = data.planRuns.filter((run) => run.summary?.verified !== undefined || run.lastVerificationSummary);
  if (verifiedPlanRuns.length > 0) {
    lines.push(`- Verification-aware plan runs: ${verifiedPlanRuns.length}`);
  }

  const verificationTasks = data.parallelTasks.filter(isVerificationParallelTask);
  if (verificationTasks.length > 0) {
    lines.push(`- Background verification tasks: ${verificationTasks.length}`);
    verificationTasks.slice(0, maxItems).forEach((task) => {
      lines.push(`  - ${task.id}: ${task.status} — ${getParallelTaskSummary(task, maxContentLength)}`);
      for (const evidence of getParallelTaskEvidenceLines(task, maxContentLength)) {
        lines.push(`    - ${evidence.trim()}`);
      }
    });
  } else if (data.parallelTasks.length > 0) {
    lines.push(`- Background tasks: ${data.parallelTasks.length}`);
  }

  return lines.join("\n").trim() + "\n";
}

export function exportSessionMarkdown(sessionId: string, options?: SessionExportOptions): string {
  const data = loadExportData(sessionId, options);
  assertExportable(data, sessionId);
  return renderSessionDocument(data, "markdown", options);
}

export function exportSessionToText(sessionId: string, options?: SessionExportOptions): string {
  const data = loadExportData(sessionId, options);
  assertExportable(data, sessionId);
  return renderSessionDocument(data, "text", options);
}

export function exportSessionPrDescription(sessionId: string, options?: SessionExportOptions): string {
  const data = loadExportData(sessionId, options);
  assertExportable(data, sessionId);
  return renderPrDescription(data, options);
}
