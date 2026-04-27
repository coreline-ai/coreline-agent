/**
 * Tool Registry — register, look up, and list tools.
 */

import type { Tool, ToolRegistry as IToolRegistry } from "./types.js";
import { toolToDefinition } from "./types.js";
import type { ToolDefinition } from "../providers/types.js";

export class ToolRegistryImpl implements IToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  getByName(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  async getToolDefinitions(): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      definitions.push(await toolToDefinition(tool));
    }
    return definitions;
  }
}
