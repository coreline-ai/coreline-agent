/**
 * ListMcpResourcesTool — read-only MCP resources/list wrapper.
 */

import { z } from "zod";
import { buildTool } from "../types.js";
import type { PermissionResult, ToolResult, ToolUseContext } from "../types.js";
import type { McpResourceInventoryEntry } from "../../mcp/types.js";
import { resolveMcpConnectionManager, type McpResourceToolFactoryOptions } from "./shared.js";

export type ListMcpResourcesInput = {
  server?: string;
  refresh?: boolean;
};

export interface ListMcpResourcesOutput {
  resources: McpResourceInventoryEntry[];
  count: number;
  server?: string;
  refreshed: boolean;
  error?: string;
}

const inputSchema = z.object({
  server: z.string().optional().describe("Optional MCP server name. Omit to list resources from all enabled servers."),
  refresh: z.boolean().optional().describe("Refresh the MCP server resource cache before listing."),
});

export function createListMcpResourcesTool(options: McpResourceToolFactoryOptions = {}) {
  return buildTool<ListMcpResourcesInput, ListMcpResourcesOutput>({
    name: "ListMcpResources",
    description:
      "List resources exposed by configured MCP servers. Read-only and concurrency-safe. " +
      "Use server to target a specific MCP server when needed.",
    inputSchema,
    maxResultSizeChars: 100_000,

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: (): PermissionResult => ({ behavior: "allow", reason: "MCP resource listing is read-only" }),

    async call(input, _context: ToolUseContext): Promise<ToolResult<ListMcpResourcesOutput>> {
      const manager = resolveMcpConnectionManager(options);
      const server = input.server?.trim() || undefined;
      const refreshed = input.refresh === true;

      try {
        const resources = await manager.listResources(server, refreshed);
        return {
          data: {
            resources,
            count: resources.length,
            server,
            refreshed,
          },
        };
      } catch (error) {
        return {
          data: {
            resources: [],
            count: 0,
            server,
            refreshed,
            error: error instanceof Error ? error.message : String(error),
          },
          isError: true,
        };
      }
    },

    formatResult(output: ListMcpResourcesOutput): string {
      if (output.error) {
        return `Error listing MCP resources: ${output.error}`;
      }

      if (output.resources.length === 0) {
        return output.server
          ? `No MCP resources found on server "${output.server}".`
          : "No MCP resources found.";
      }

      const lines = [`Found ${output.count} MCP resource(s):`];
      for (const resource of output.resources) {
        const label = resource.name || resource.title || resource.uri;
        const mime = resource.mimeType ? ` (${resource.mimeType})` : "";
        const size = typeof resource.size === "number" ? `, ${resource.size} bytes` : "";
        lines.push(`- [${resource.serverName}] ${label}${mime}${size}`);
        lines.push(`  uri: ${resource.uri}`);
        if (resource.description) {
          lines.push(`  description: ${resource.description}`);
        }
      }
      return lines.join("\n");
    },
  });
}

export const ListMcpResourcesTool = createListMcpResourcesTool();
