/**
 * MCP config loader — minimal YAML/JSON config for stdio servers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type {
  McpConfigFile,
  McpConfigLoadSnapshot,
  McpServerConfig,
  McpServerSelectionSnapshot,
} from "./types.js";

export const DEFAULT_MCP_CONFIG_PATH = join(homedir(), ".coreline-agent", "mcp.yml");

export const mcpServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  shutdownTimeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  protocolVersion: z.string().optional(),
});

export const mcpConfigFileSchema = z.object({
  defaultServer: z.string().min(1).optional(),
  servers: z.array(mcpServerConfigSchema).default([]),
}).superRefine((config, ctx) => {
  const seen = new Set<string>();
  for (const [index, server] of config.servers.entries()) {
    if (seen.has(server.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate MCP server name: ${server.name}`,
        path: ["servers", index, "name"],
      });
      continue;
    }
    seen.add(server.name);
  }
});

export function parseMcpConfig(data: unknown): McpConfigFile {
  return mcpConfigFileSchema.parse(data);
}

export function loadMcpConfig(filePath: string = DEFAULT_MCP_CONFIG_PATH): McpConfigFile {
  return loadMcpConfigWithStatus(filePath).config;
}

export function loadMcpConfigWithStatus(filePath: string = DEFAULT_MCP_CONFIG_PATH): McpConfigLoadSnapshot {
  if (!existsSync(filePath)) {
    return {
      filePath,
      state: "missing",
      config: parseMcpConfig({}),
    };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    return {
      filePath,
      state: "loaded",
      config: parseMcpConfig(parsed),
    };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[mcp] Failed to load ${filePath}: ${message}`);
    return {
      filePath,
      state: "invalid",
      error: message,
      config: parseMcpConfig({}),
    };
  }
}

export function saveMcpConfig(filePath: string, config: McpConfigFile): void {
  ensureParentDir(filePath);
  const tempPath = join(
    dirname(filePath),
    `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  writeFileSync(tempPath, stringifyYaml(mcpConfigFileSchema.parse(config)), "utf-8");
  renameSync(tempPath, filePath);
}

export function resolveDefaultMcpServerName(config: McpConfigFile): string | undefined {
  return resolveMcpServerSelection(config).selectedServerName;
}

export function getEnabledMcpServers(config: McpConfigFile): McpServerConfig[] {
  return config.servers.filter((server) => server.enabled !== false);
}

export function getDisabledMcpServers(config: McpConfigFile): McpServerConfig[] {
  return config.servers.filter((server) => server.enabled === false);
}

export function getAllMcpServers(config: McpConfigFile): McpServerConfig[] {
  return config.servers.map((server) => ({ ...server, args: [...(server.args ?? [])], env: server.env ? { ...server.env } : undefined }));
}

export function resolveMcpServerSelection(
  config: McpConfigFile,
  requestedServerName?: string,
): McpServerSelectionSnapshot {
  const enabledServerNames = getEnabledMcpServers(config).map((server) => server.name);
  const allServers = config.servers;
  const defaultServerName = config.defaultServer;

  if (requestedServerName) {
    const requested = allServers.find((server) => server.name === requestedServerName);
    if (!requested) {
      return {
        requestedServerName,
        defaultServerName,
        enabledServerNames,
        state: "missing",
        reason: `MCP server "${requestedServerName}" is not configured`,
      };
    }

    if (requested.enabled === false) {
      return {
        requestedServerName,
        defaultServerName,
        enabledServerNames,
        selectedServerName: requested.name,
        state: "disabled",
        reason: `MCP server "${requestedServerName}" is configured but disabled`,
      };
    }

    return {
      requestedServerName,
      defaultServerName,
      enabledServerNames,
      selectedServerName: requested.name,
      state: "selected",
      reason: `Explicit MCP server "${requestedServerName}" selected`,
    };
  }

  if (defaultServerName) {
    const configuredDefault = allServers.find((server) => server.name === defaultServerName);
    if (configuredDefault && configuredDefault.enabled !== false) {
      return {
        defaultServerName,
        enabledServerNames,
        selectedServerName: configuredDefault.name,
        state: "selected",
        reason: `Default MCP server "${defaultServerName}" selected`,
      };
    }

    const fallback = enabledServerNames[0];
    if (fallback) {
      return {
        defaultServerName,
        enabledServerNames,
        selectedServerName: fallback,
        state: "fallback",
        reason: configuredDefault
          ? `Default MCP server "${defaultServerName}" is disabled; falling back to "${fallback}"`
          : `Default MCP server "${defaultServerName}" is not configured; falling back to "${fallback}"`,
      };
    }

    return {
      defaultServerName,
      enabledServerNames,
      state: "none",
      reason: `No enabled MCP servers available for default server "${defaultServerName}"`,
    };
  }

  const fallback = enabledServerNames[0];
  if (fallback) {
    return {
      enabledServerNames,
      selectedServerName: fallback,
      state: "fallback",
      reason: `No default MCP server configured; using first enabled server "${fallback}"`,
    };
  }

  return {
    enabledServerNames,
    state: "none",
    reason: "No enabled MCP servers configured",
  };
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
