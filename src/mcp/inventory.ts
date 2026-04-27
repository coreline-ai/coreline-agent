/**
 * MCP inventory mapping helpers.
 */

import type { ToolDefinition } from "../providers/types.js";
import type {
  McpCallToolResult,
  McpServerInfo,
  McpToolDescriptor,
  McpToolInventoryEntry,
} from "./types.js";

export interface McpListToolsResult {
  tools?: McpToolDescriptor[];
  nextCursor?: string;
}

export function normalizeMcpInventoryEntry(
  serverName: string,
  tool: McpToolDescriptor,
  serverInfo?: McpServerInfo,
): McpToolInventoryEntry {
  return {
    ...tool,
    serverName,
    serverTitle: serverInfo?.title ?? serverInfo?.name,
    qualifiedName: qualifyMcpToolName(serverName, tool.name),
  };
}

export function normalizeMcpInventory(
  serverName: string,
  tools: McpToolDescriptor[],
  serverInfo?: McpServerInfo,
): McpToolInventoryEntry[] {
  return tools.map((tool) => normalizeMcpInventoryEntry(serverName, tool, serverInfo));
}

export function qualifyMcpToolName(serverName: string, toolName: string): string {
  return `${serverName}:${toolName}`;
}

export function mapMcpInventoryToToolDefinitions(
  inventory: McpToolInventoryEntry[],
): ToolDefinition[] {
  return inventory.map((tool) => ({
    name: tool.qualifiedName,
    description: formatToolDescription(tool),
    inputSchema: tool.inputSchema,
  }));
}

export function formatToolDescription(tool: Pick<McpToolInventoryEntry, "description" | "title" | "serverName">): string {
  const base = tool.description?.trim() || "MCP tool";
  const title = tool.title?.trim();
  if (title && title !== base) {
    return `${title} — ${base}`;
  }
  return `${base} [server: ${tool.serverName}]`;
}

export function renderMcpCallResult(result: McpCallToolResult): string {
  const parts: string[] = [];

  for (const block of result.content ?? []) {
    const rendered = renderContentBlock(block);
    if (rendered) {
      parts.push(rendered);
    }
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(renderStructuredContent(result.structuredContent));
  }

  if (parts.length === 0) {
    parts.push("[No output]");
  }

  if (result.isError) {
    parts.push("[MCP error]");
  }

  return parts.join("\n");
}

export function summarizeMcpCallResult(result: McpCallToolResult): string {
  return renderMcpCallResult(result);
}

function renderContentBlock(block: Record<string, unknown>): string {
  if (typeof block.text === "string" && block.text.trim()) {
    return block.text.trim();
  }

  if (typeof block.content === "string" && block.content.trim()) {
    return block.content.trim();
  }

  if (block.type === "resource" && typeof block.uri === "string") {
    return `[resource] ${block.uri}`;
  }

  if (block.type === "image" && typeof block.mimeType === "string") {
    return `[image] ${block.mimeType}`;
  }

  return renderStructuredContent(block);
}

function renderStructuredContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
