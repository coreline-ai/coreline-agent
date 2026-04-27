/**
 * MCP operational policy helpers.
 *
 * This file keeps the policy heuristics close to the MCP bridge/runtime so
 * permission and concurrency decisions can be reused by the engine and by
 * bridge-side tool metadata.
 */

export interface McpToolPolicyDecision {
  behavior: "allow" | "ask";
  reason: string;
  isReadOnly: boolean;
}

const READ_ONLY_HINT_PATTERNS = [
  /(^|[:/_-])(list|read|get|fetch|search|query|inspect|describe|status|show|lookup|info|help)([A-Z0-9_:-]|$)/i,
  /(^|[:/_-])(browse|discover|catalog|explore)([A-Z0-9_:-]|$)/i,
];

const WRITE_HINT_PATTERNS = [
  /(^|[:/_-])(write|edit|update|delete|remove|create|insert|patch|apply|exec|run|shell|command|install|publish|deploy|set|replace|push)([A-Z0-9_:-]|$)/i,
];

export function classifyMcpToolPermission(toolName: string): McpToolPolicyDecision {
  const safeName = toolName.trim();
  const readOnly = isLikelyReadOnlyMcpToolName(safeName);

  if (readOnly) {
    return {
      behavior: "allow",
      reason: `MCP tool "${safeName}" looks read-only`,
      isReadOnly: true,
    };
  }

  if (looksWriteCapable(safeName)) {
    return {
      behavior: "ask",
      reason: `MCP tool "${safeName}" looks write-capable and requires confirmation`,
      isReadOnly: false,
    };
  }

  return {
    behavior: "ask",
    reason: `MCP tool "${safeName}" requires confirmation unless explicitly marked read-only`,
    isReadOnly: false,
  };
}

export function isLikelyReadOnlyMcpToolName(toolName: string): boolean {
  if (!toolName.includes(":")) {
    return false;
  }

  return READ_ONLY_HINT_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function looksWriteCapable(toolName: string): boolean {
  return WRITE_HINT_PATTERNS.some((pattern) => pattern.test(toolName));
}
