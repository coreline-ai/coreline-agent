/**
 * ToolResult — renders tool execution status and results.
 */

import React from "react";
import { Box, Text } from "ink";
import { renderMinimalMarkdown } from "./streaming-output.js";

export interface ToolCallDisplay {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  status: "running" | "done";
}

export interface ToolResultProps {
  toolCall: ToolCallDisplay;
  verbose?: boolean;
}

export interface ParsedAgentResult {
  reason?: string;
  mode?: "single" | "coordinator";
  status?: string;
  turns?: number;
  childCount?: number;
  completedCount?: number;
  failedCount?: number;
  partial?: boolean;
  usedTools: string[];
  summary?: string;
  finalText?: string;
}

function parseKeyValueLine(line: string): [string, string] | null {
  const index = line.indexOf(":");
  if (index < 0) return null;
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  if (!key) return null;
  return [key, value];
}

export function parseAgentResult(result: string): ParsedAgentResult | null {
  if (!result.includes("AGENT_RESULT")) return null;

  const lines = result.split("\n");
  const parsed: ParsedAgentResult = { usedTools: [] };
  let inFinalText = false;
  const finalTextLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "FINAL_TEXT_START") {
      inFinalText = true;
      continue;
    }
    if (trimmed === "FINAL_TEXT_END") {
      inFinalText = false;
      continue;
    }
    if (inFinalText) {
      finalTextLines.push(line);
      continue;
    }

    const kv = parseKeyValueLine(line);
    if (!kv) continue;

    const [key, value] = kv;
    if (key === "reason") parsed.reason = value;
    if (key === "mode" && (value === "single" || value === "coordinator")) parsed.mode = value;
    if (key === "status") parsed.status = value;
    if (value === "partial") parsed.partial = true;
    if (key === "turns") {
      const turns = Number.parseInt(value, 10);
      if (Number.isFinite(turns)) parsed.turns = turns;
    }
    if (key === "child_count") {
      const childCount = Number.parseInt(value, 10);
      if (Number.isFinite(childCount)) parsed.childCount = childCount;
    }
    if (key === "completed_count") {
      const completedCount = Number.parseInt(value, 10);
      if (Number.isFinite(completedCount)) parsed.completedCount = completedCount;
    }
    if (key === "failed_count") {
      const failedCount = Number.parseInt(value, 10);
      if (Number.isFinite(failedCount)) parsed.failedCount = failedCount;
    }
    if (key === "partial") {
      parsed.partial = value === "true" || value === "partial";
    }
    if (key === "used_tools") {
      parsed.usedTools = value === "(none)" ? [] : value.split(",").map((part) => part.trim()).filter(Boolean);
    }
    if (key === "summary") parsed.summary = value;
  }

  parsed.finalText = finalTextLines.join("\n").trim();
  return parsed;
}

export function getToolDetailLine(toolCall: ToolCallDisplay): string | undefined {
  const result = toolCall.result ?? "";

  if (toolCall.toolName === "Agent") {
    const parsed = parseAgentResult(String(result));
    if (!parsed) return undefined;

    const parts = [
      parsed.mode === "coordinator" ? "coordinator" : "child",
      `turns=${parsed.turns ?? 0}`,
      `tools=${parsed.usedTools.length > 0 ? parsed.usedTools.join(", ") : "(none)"}`,
      parsed.mode === "coordinator"
        ? `children=${parsed.childCount ?? 0} completed=${parsed.completedCount ?? 0} failed=${parsed.failedCount ?? 0}`
        : undefined,
      `approval=${parsed.partial ? "partial" : parsed.reason ?? "completed"}`,
    ];

    return parts.filter(Boolean).join(" | ");
  }

  if (toolCall.isError && /permission denied/i.test(String(result))) {
    return "approval=denied";
  }

  return undefined;
}

export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return String(input.command ?? "").slice(0, 80);
    case "FileRead":
    case "FileWrite":
    case "FileEdit":
      return String(input.file_path ?? "");
    case "Glob":
      return `${input.pattern ?? ""}${input.path ? ` in ${input.path}` : ""}`;
    case "Grep":
      return `/${input.pattern ?? ""}/` + (input.path ? ` in ${input.path}` : "");
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

export function truncateResult(result: string, maxLines: number = 10): string {
  const lines = result.split("\n");
  if (lines.length <= maxLines) return result;
  return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
}

export function getToolStatusLabel(toolCall: ToolCallDisplay): string {
  if (toolCall.status === "running") return "running";
  return toolCall.isError ? "failed" : "done";
}

export function ToolResult({ toolCall, verbose }: ToolResultProps) {
  const icon = toolCall.status === "running" ? "⟳" : toolCall.isError ? "✗" : "✓";
  const iconColor = toolCall.status === "running" ? "yellow" : toolCall.isError ? "red" : "green";
  const statusLabel = getToolStatusLabel(toolCall);
  const summary = summarizeInput(toolCall.toolName, toolCall.input);
  const detailLine = getToolDetailLine(toolCall);
  const showResult = toolCall.status === "done" && toolCall.result !== undefined && toolCall.result !== null;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      marginY={0}
      borderStyle="single"
      borderColor={toolCall.isError ? "red" : toolCall.status === "running" ? "yellow" : "gray"}
    >
      <Box gap={1} flexWrap="wrap">
        <Text color={iconColor}>{icon}</Text>
        <Text color="cyan" bold>{toolCall.toolName}</Text>
        <Text dimColor>{statusLabel}</Text>
        <Text dimColor>|</Text>
        <Text dimColor>{summary}</Text>
      </Box>
      {detailLine && (
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>{detailLine}</Text>
        </Box>
      )}

      {showResult && (
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          {renderMinimalMarkdown(
            verbose ? String(toolCall.result) : truncateResult(String(toolCall.result)),
            false,
          )}
        </Box>
      )}
      {toolCall.status === "running" && (
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>Working…</Text>
        </Box>
      )}
    </Box>
  );
}
