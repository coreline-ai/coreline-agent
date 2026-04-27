export * from "./list-mcp-resources-tool.js";
export * from "./read-mcp-resource-tool.js";
export * from "./shared.js";

import { createListMcpResourcesTool } from "./list-mcp-resources-tool.js";
import { createReadMcpResourceTool } from "./read-mcp-resource-tool.js";
import type { McpResourceToolFactoryOptions } from "./shared.js";

export function createMcpResourceTools(options: McpResourceToolFactoryOptions = {}) {
  return [
    createListMcpResourcesTool(options),
    createReadMcpResourceTool(options),
  ];
}
