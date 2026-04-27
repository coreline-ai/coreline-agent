import { McpConnectionManager } from "../../mcp/connection.js";
import type { ToolResultStorageOptions } from "../result-storage.js";

export interface McpResourceToolStorageOptions extends Omit<ToolResultStorageOptions, "cwd"> {}

export interface McpResourceToolFactoryOptions {
  manager?: McpConnectionManager;
  getManager?: () => McpConnectionManager;
  storage?: McpResourceToolStorageOptions;
}

let defaultManager: McpConnectionManager | undefined;

export function resolveMcpConnectionManager(options: McpResourceToolFactoryOptions = {}): McpConnectionManager {
  if (options.manager) {
    return options.manager;
  }
  if (options.getManager) {
    return options.getManager();
  }
  defaultManager ??= new McpConnectionManager();
  return defaultManager;
}

export function resolveMcpReadServerName(
  manager: McpConnectionManager,
  requestedServerName?: string,
): string {
  const requested = requestedServerName?.trim();
  if (requested) {
    return requested;
  }

  const defaultServer = manager.getDefaultServerName();
  if (defaultServer) {
    return defaultServer;
  }

  const available = manager.getAvailableServerNames();
  if (available.length === 1) {
    return available[0]!;
  }

  const label = available.length > 0 ? available.join(", ") : "(none)";
  throw new Error(`MCP server is required when no default server is configured. Available: ${label}`);
}
