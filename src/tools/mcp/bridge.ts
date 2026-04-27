/**
 * MCP → internal tool bridge.
 */

import { z } from "zod";
import { buildTool, type Tool } from "../types.js";
import { classifyMcpToolPermission, isLikelyReadOnlyMcpToolName } from "../../mcp/policy.js";
import {
  mapMcpInventoryToToolDefinitions,
  normalizeMcpInventory,
  renderMcpCallResult,
  type McpToolBridgeCallFn,
  type McpToolBridgeOptions,
  type McpToolDescriptor,
  type McpToolInventoryEntry,
  type McpToolCallResponse,
} from "../../mcp/index.js";
import type { McpClientSession, McpConnectionManager } from "../../mcp/connection.js";

const passthroughObject = z.object({}).passthrough();

export function mapMcpInventoryEntriesToToolDefinitions(inventory: McpToolInventoryEntry[]) {
  return mapMcpInventoryToToolDefinitions(inventory);
}

export async function createMcpToolBridgeToolsFromInventory(
  inventory: McpToolInventoryEntry[],
  callTool: McpToolBridgeCallFn,
  options: McpToolBridgeOptions = {},
): Promise<Tool[]> {
  assertNoBridgeNameCollisions(inventory, options);
  const tools: Tool[] = [];

  for (const entry of inventory) {
    const toolName = qualifyBridgeToolName(entry, options);
    const description = entry.description?.trim() || `MCP tool from ${entry.serverName}`;

    tools.push(
      buildTool({
        name: toolName,
        description,
        inputSchema: passthroughObject,
        async call(input) {
          const result = await callTool(entry.name, input as Record<string, unknown>, entry);
          return { data: result, isError: result.result.isError ?? false };
        },
        formatResult(output: McpToolCallResponse, toolUseId: string): string {
          const prefix = `[MCP ${entry.serverName}:${entry.name}]`;
          const body = renderMcpCallResult(output.result);
          return `${prefix}\n${body}`;
        },
        isReadOnly() {
          return entry.annotations?.readOnlyHint === true || isLikelyReadOnlyMcpToolName(toolName);
        },
        isConcurrencySafe() {
          return entry.annotations?.readOnlyHint === true || isLikelyReadOnlyMcpToolName(toolName);
        },
        checkPermissions() {
          if (entry.annotations?.readOnlyHint === true || isLikelyReadOnlyMcpToolName(toolName)) {
            return { behavior: "allow", reason: `MCP tool "${toolName}" is read-only` };
          }
          return classifyMcpToolPermission(toolName);
        },
      }),
    );
  }

  return tools;
}

export async function createMcpToolBridgeTools(
  session: McpClientSession,
  options: McpToolBridgeOptions = {},
): Promise<Tool[]> {
  const inventory = await session.listTools();
  return createMcpToolBridgeToolsFromInventory(
    inventory,
    async (toolName, input, entry) => session.callTool(toolName, input),
    options,
  );
}

export async function createMcpToolBridgeToolsForServer(
  manager: McpConnectionManager,
  serverName?: string,
  options: McpToolBridgeOptions = {},
): Promise<Tool[]> {
  const inventory = await manager.listTools(serverName);
  return createMcpToolBridgeToolsFromInventory(
    inventory,
    async (toolName, input) => manager.callTool(resolveServerNameFromInventory(inventory, serverName), toolName, input),
    options,
  );
}

export function normalizeMcpToolDescriptors(
  serverName: string,
  tools: McpToolDescriptor[],
  serverInfo?: { name: string; title?: string },
): McpToolInventoryEntry[] {
  return normalizeMcpInventory(serverName, tools, serverInfo);
}

function qualifyBridgeToolName(entry: McpToolInventoryEntry, options: McpToolBridgeOptions): string {
  if (options.namespace) {
    return `${options.namespace}:${entry.name}`;
  }
  return entry.qualifiedName;
}

function resolveServerNameFromInventory(
  inventory: McpToolInventoryEntry[],
  explicitServerName?: string,
): string {
  if (explicitServerName) {
    return explicitServerName;
  }
  const first = inventory[0]?.serverName;
  if (!first) {
    throw new Error("Cannot resolve MCP server name for bridge tools");
  }
  return first;
}

function assertNoBridgeNameCollisions(
  inventory: McpToolInventoryEntry[],
  options: McpToolBridgeOptions,
): void {
  const names = new Map<string, string[]>();
  for (const entry of inventory) {
    const bridged = qualifyBridgeToolName(entry, options);
    const existing = names.get(bridged) ?? [];
    existing.push(`${entry.serverName}:${entry.name}`);
    names.set(bridged, existing);
  }

  const collisions = [...names.entries()].filter(([, entries]) => entries.length > 1);
  if (collisions.length === 0) {
    return;
  }

  const details = collisions
    .map(([name, entries]) => `${name} <= ${entries.join(", ")}`)
    .join("; ");
  throw new Error(`MCP bridge tool name collision detected: ${details}`);
}
