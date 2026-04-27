/**
 * ReadMcpResourceTool — read-only MCP resources/read wrapper.
 */

import { z } from "zod";
import { buildTool } from "../types.js";
import type { PermissionResult, ToolResult, ToolUseContext } from "../types.js";
import type { McpResourceContents } from "../../mcp/types.js";
import {
  EMPTY_TOOL_RESULT_MARKER,
  storeToolResultSync,
  type ToolResultStorageOptions,
} from "../result-storage.js";
import {
  resolveMcpConnectionManager,
  resolveMcpReadServerName,
  type McpResourceToolFactoryOptions,
} from "./shared.js";

export type ReadMcpResourceInput = {
  uri: string;
  server?: string;
};

export interface ReadMcpResourceOutput {
  serverName: string;
  uri: string;
  contents: McpResourceContents[];
  storageOptions: ToolResultStorageOptions;
  error?: string;
}

const inputSchema = z.object({
  uri: z.string().min(1).describe("MCP resource URI to read."),
  server: z.string().optional().describe("Optional MCP server name. Defaults to configured default server."),
});

export function createReadMcpResourceTool(options: McpResourceToolFactoryOptions = {}) {
  return buildTool<ReadMcpResourceInput, ReadMcpResourceOutput>({
    name: "ReadMcpResource",
    description:
      "Read a resource exposed by an MCP server. Text resources are returned directly; " +
      "blob/base64 resources are saved to a local tool-results file and returned as a path message.",
    inputSchema,
    maxResultSizeChars: 200_000,

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: (): PermissionResult => ({ behavior: "allow", reason: "MCP resource reads are read-only" }),

    async call(input, context: ToolUseContext): Promise<ToolResult<ReadMcpResourceOutput>> {
      const manager = resolveMcpConnectionManager(options);
      let serverName = input.server?.trim() || "";
      const storageOptions: ToolResultStorageOptions = {
        cwd: context.cwd,
        ...options.storage,
      };

      try {
        serverName = resolveMcpReadServerName(manager, input.server);
        const response = await manager.readResource(serverName, input.uri);
        return {
          data: {
            serverName,
            uri: input.uri,
            contents: response.result.contents,
            storageOptions,
          },
        };
      } catch (error) {
        return {
          data: {
            serverName: serverName || input.server?.trim() || "",
            uri: input.uri,
            contents: [],
            storageOptions,
            error: error instanceof Error ? error.message : String(error),
          },
          isError: true,
        };
      }
    },

    formatResult(output: ReadMcpResourceOutput, toolUseId: string): string {
      if (output.error) {
        return `Error reading MCP resource${output.serverName ? ` from ${output.serverName}` : ""}: ${output.error}`;
      }

      const lines = [`[MCP resource ${output.serverName}:${output.uri}]`];
      if (output.contents.length === 0) {
        lines.push("[No resource contents]");
        return lines.join("\n");
      }

      output.contents.forEach((content, index) => {
        const contentUri = content.uri || output.uri;
        if ("text" in content) {
          lines.push(content.text || EMPTY_TOOL_RESULT_MARKER);
          return;
        }

        const stored = storeToolResultSync(
          {
            toolUseId: `${toolUseId}-${index + 1}`,
            toolName: "ReadMcpResource",
            content: content.blob,
            encoding: "base64",
            kind: "binary",
            mimeType: content.mimeType,
            sourceUri: contentUri,
          },
          output.storageOptions,
        );

        lines.push(`Blob resource saved for ${contentUri}:`);
        lines.push(stored.previewMessage);
      });

      return lines.join("\n");
    },
  });
}

export const ReadMcpResourceTool = createReadMcpResourceTool();
