/**
 * PermissionPrompt — interactive UI for "ask" permission behavior.
 * Shown when a tool requires user confirmation before execution.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface PermissionPromptProps {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  onResolve: (allowed: boolean) => void;
}

const CHILD_WRITE_TOOL_NAMES = new Set(["FileWrite", "FileEdit", "MemoryWrite"]);

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function isDelegatedWriteRequest(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "Agent") return false;
  const allowedTools = getStringArray(input.allowedTools);
  return allowedTools.some((tool) => CHILD_WRITE_TOOL_NAMES.has(tool));
}

export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": return String(input.command ?? "").slice(0, 120);
    case "FileRead": return String(input.file_path ?? "");
    case "FileWrite": return `Write to ${input.file_path}`;
    case "FileEdit": return `Edit ${input.file_path}`;
    case "Agent": {
      const prompt = String(input.prompt ?? "").trim();
      const allowedTools = getStringArray(input.allowedTools);
      const toolSuffix = allowedTools.length > 0 ? ` [${allowedTools.join(", ")}]` : "";
      return `${prompt}${toolSuffix}`.slice(0, 120);
    }
    default: return JSON.stringify(input).slice(0, 80);
  }
}

export interface PermissionPromptDetails {
  summary: string;
  scopeLabel: string;
  reasonLabel: string;
  policyLabel?: string;
  targetLabel?: string;
  subtaskLabel?: string;
}

export function getPermissionPromptDetails(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): PermissionPromptDetails {
  const summary = summarizeInput(toolName, input);
  const delegatedWrite = isDelegatedWriteRequest(toolName, input);
  const writeTool = toolName === "FileWrite" || toolName === "FileEdit" || toolName === "MemoryWrite";
  const allowedTools = getStringArray(input.allowedTools);
  const subtaskCount = Array.isArray(input.subtasks) ? input.subtasks.length : 0;

  const scopeLabel = delegatedWrite
    ? "Delegated child (write-capable)"
    : writeTool
      ? "Write request"
      : "Tool request";

  const reasonLabel = reason;

  const policyLabel = delegatedWrite
    ? "Non-interactive child runs deny write requests automatically."
    : writeTool
      ? "Non-interactive child runs deny write requests automatically."
      : undefined;

  const targetLabel = delegatedWrite && allowedTools.length > 0
    ? `Child may use: ${allowedTools.join(", ")}`
    : undefined;

  const subtaskLabel = toolName === "Agent" && subtaskCount > 0
    ? `${subtaskCount} delegated child task${subtaskCount === 1 ? "" : "s"}`
    : undefined;

  return { summary, scopeLabel, reasonLabel, policyLabel, targetLabel, subtaskLabel };
}

export function PermissionPrompt({ toolName, input, reason, onResolve }: PermissionPromptProps) {
  const [resolved, setResolved] = useState(false);

  useInput((char, key) => {
    if (resolved) return;
    if (char === "y" || char === "Y" || key.return) {
      setResolved(true);
      onResolve(true);
    } else if (char === "n" || char === "N" || key.escape) {
      setResolved(true);
      onResolve(false);
    }
  });

  const details = getPermissionPromptDetails(toolName, input, reason);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
      <Box gap={1}>
        <Text color="yellow" bold>⚠ Permission Required</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box gap={1}>
          <Text dimColor>Tool:</Text>
          <Text bold>{toolName}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Scope:</Text>
          <Text>{details.scopeLabel}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Action:</Text>
          <Text>{details.summary}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Reason:</Text>
          <Text>{details.reasonLabel}</Text>
        </Box>
        {details.policyLabel && (
          <Box gap={1}>
            <Text dimColor>Policy:</Text>
            <Text color="yellow">{details.policyLabel}</Text>
          </Box>
        )}
        {details.targetLabel && (
          <Box gap={1}>
            <Text dimColor>Target:</Text>
            <Text>{details.targetLabel}</Text>
          </Box>
        )}
        {details.subtaskLabel && (
          <Box gap={1}>
            <Text dimColor>Batch:</Text>
            <Text>{details.subtaskLabel}</Text>
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        {resolved ? (
          <Text dimColor>(resolved)</Text>
        ) : (
          <Text>
            <Text color="green" bold>[Y]</Text><Text>es</Text>
            <Text> / </Text>
            <Text color="red" bold>[N]</Text><Text>o</Text>
            <Text dimColor> (Enter=Yes, Esc=No)</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
