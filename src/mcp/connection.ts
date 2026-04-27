/**
 * MCP client session and connection manager.
 */

import {
  type McpConfigFile,
  type McpConnectionManagerOptions,
  type McpConnectionManagerStatusSnapshot,
  type McpInitializeResult,
  type McpListResourcesResult,
  type McpReadResourceResult,
  type McpResourceDescriptor,
  type McpResourceInventoryEntry,
  type McpResourceReadResponse,
  type McpServerConfig,
  type McpServerInfo,
  type McpSessionStatusSnapshot,
  type McpToolCallResponse,
  type McpToolInventoryEntry,
  type McpTransport,
} from "./types.js";
import { MCP_DEFAULT_PROTOCOL_VERSION } from "./types.js";
import { getAllMcpServers, getEnabledMcpServers, loadMcpConfig, resolveDefaultMcpServerName, resolveMcpServerSelection } from "./config.js";
import { normalizeMcpInventory, type McpListToolsResult, renderMcpCallResult } from "./inventory.js";
import { StdioMcpTransport, type McpStdioTransportOptions } from "./stdio-transport.js";

export type McpSessionState = "idle" | "connecting" | "ready" | "closed" | "error";

export interface McpClientSessionRuntimeOptions extends McpConnectionManagerOptions {
  transport?: McpTransport;
}

export class McpClientSession {
  private readonly config: McpServerConfig;
  private readonly options: McpClientSessionRuntimeOptions;
  private transport: McpTransport;
  private initializePromise: Promise<McpInitializeResult> | null = null;
  private state: McpSessionState = "idle";
  private serverInfo: McpServerInfo | undefined;
  private toolCache: McpToolInventoryEntry[] | null = null;
  private resourceCache: McpResourceInventoryEntry[] | null = null;
  private lastError: string | undefined;
  private lastInitializedAt: Date | undefined;
  private lastToolRefreshAt: Date | undefined;
  private lastResourceRefreshAt: Date | undefined;

  constructor(config: McpServerConfig, options: McpClientSessionRuntimeOptions = {}) {
    this.config = config;
    this.options = options;
    this.transport = options.transport ?? this.createDefaultTransport(config, options);
  }

  get name(): string {
    return this.config.name;
  }

  get currentState(): McpSessionState {
    return this.state;
  }

  get currentServerInfo(): McpServerInfo | undefined {
    return this.serverInfo;
  }

  getStatusSnapshot(): McpSessionStatusSnapshot {
    return {
      serverName: this.config.name,
      enabled: this.config.enabled !== false,
      state: this.state,
      toolCount: this.toolCache?.length,
      resourceCount: this.resourceCache?.length,
      lastError: this.lastError,
      lastInitializedAt: this.lastInitializedAt?.toISOString(),
      lastToolRefreshAt: this.lastToolRefreshAt?.toISOString(),
      lastResourceRefreshAt: this.lastResourceRefreshAt?.toISOString(),
      serverInfo: this.serverInfo ? { ...this.serverInfo } : undefined,
      transport: this.describeTransport(),
    };
  }

  async initialize(): Promise<McpInitializeResult> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.state = "connecting";
    this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  async ping(timeoutMs?: number): Promise<void> {
    await this.ensureReady();
    await this.transport.request("ping", undefined, {
      timeoutMs: timeoutMs ?? this.resolveRequestTimeoutMs(),
    });
  }

  async listTools(refresh = false): Promise<McpToolInventoryEntry[]> {
    await this.ensureReady();

    if (!refresh && this.toolCache) {
      return this.toolCache.map((tool) => ({ ...tool }));
    }

    try {
      const tools: McpToolInventoryEntry[] = [];
      let cursor: string | undefined;

      do {
        const response = await this.transport.request<McpListToolsResult>("tools/list", {
          ...(cursor ? { cursor } : {}),
        }, {
          timeoutMs: this.resolveRequestTimeoutMs(),
        });

        const page = normalizeMcpInventory(this.config.name, response.tools ?? [], this.serverInfo);
        tools.push(...page);
        cursor = response.nextCursor;
      } while (cursor);

      this.toolCache = tools.map((tool) => ({ ...tool }));
      this.lastToolRefreshAt = new Date();
      this.lastError = undefined;
      return tools.map((tool) => ({ ...tool }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async callTool(toolName: string, input: Record<string, unknown>): Promise<McpToolCallResponse> {
    await this.ensureReady();
    try {
      const result = await this.transport.request<{
        content?: unknown[];
        structuredContent?: unknown;
        isError?: boolean;
      }>(
        "tools/call",
        {
          name: toolName,
          arguments: input,
        },
        {
          timeoutMs: this.resolveRequestTimeoutMs(),
        },
      );

      const normalized = {
        content: Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [],
        structuredContent: result.structuredContent,
        isError: result.isError ?? false,
      };

      this.lastError = normalized.isError ? renderMcpCallResult(normalized) : undefined;
      return {
        result: normalized,
        text: renderMcpCallResult(normalized),
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async listResources(refresh = false): Promise<McpResourceInventoryEntry[]> {
    await this.ensureReady();

    if (!refresh && this.resourceCache) {
      return this.resourceCache.map((resource) => ({ ...resource }));
    }

    try {
      const resources: McpResourceInventoryEntry[] = [];
      let cursor: string | undefined;

      do {
        const response = await this.transport.request<McpListResourcesResult>("resources/list", {
          ...(cursor ? { cursor } : {}),
        }, {
          timeoutMs: this.resolveRequestTimeoutMs(),
        });

        const page = normalizeMcpResourceInventory(
          this.config.name,
          Array.isArray(response?.resources) ? response.resources : [],
          this.serverInfo,
        );
        resources.push(...page);
        cursor = response.nextCursor;
      } while (cursor);

      this.resourceCache = resources.map((resource) => ({ ...resource }));
      this.lastResourceRefreshAt = new Date();
      this.lastError = undefined;
      return resources.map((resource) => ({ ...resource }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async readResource(uri: string): Promise<McpResourceReadResponse> {
    await this.ensureReady();
    try {
      const result = await this.transport.request<McpReadResourceResult>(
        "resources/read",
        { uri },
        {
          timeoutMs: this.resolveRequestTimeoutMs(),
        },
      );

      const normalized = normalizeMcpReadResourceResult(result);
      this.lastError = undefined;
      return {
        result: normalized,
        text: renderMcpReadResourceResult(normalized),
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    await this.transport.close();
  }

  async refreshTools(): Promise<McpToolInventoryEntry[]> {
    return this.listTools(true);
  }

  async refreshResources(): Promise<McpResourceInventoryEntry[]> {
    return this.listResources(true);
  }

  private async ensureReady(): Promise<void> {
    await this.initialize();
  }

  private async initializeInternal(): Promise<McpInitializeResult> {
    try {
      const initResult = await this.transport.request<McpInitializeResult>(
        "initialize",
        {
          protocolVersion: this.resolveProtocolVersion(),
          capabilities: {},
          clientInfo: this.resolveClientInfo(),
        },
        { timeoutMs: this.resolveRequestTimeoutMs() },
      );

      this.serverInfo = initResult.serverInfo;
      await this.transport.notify("notifications/initialized");
      this.state = "ready";
      this.lastInitializedAt = new Date();
      return initResult;
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private describeTransport(): McpSessionStatusSnapshot["transport"] {
    if (this.transport instanceof StdioMcpTransport) {
      return this.transport.getDiagnostics();
    }

    return { kind: "custom" };
  }

  private resolveProtocolVersion(): string {
    return this.config.protocolVersion ?? this.options.protocolVersion ?? MCP_DEFAULT_PROTOCOL_VERSION;
  }

  private resolveRequestTimeoutMs(): number {
    return this.config.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
  }

  private resolveClientInfo(): NonNullable<McpConnectionManagerOptions["clientInfo"]> {
    return (
      this.options.clientInfo ?? {
        name: "coreline-agent",
        version: "0.1.0",
      }
    );
  }

  private createDefaultTransport(
    config: McpServerConfig,
    options: McpClientSessionRuntimeOptions,
  ): McpTransport {
    const transportOptions: McpStdioTransportOptions = {
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      timeoutMs: config.timeoutMs ?? options.requestTimeoutMs ?? 30_000,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? options.shutdownTimeoutMs ?? 2_000,
      protocolVersion: this.resolveProtocolVersion(),
      clientInfo: this.resolveClientInfo(),
    };
    return new StdioMcpTransport(transportOptions);
  }
}

export interface McpConnectionManagerConfig {
  config?: McpConfigFile;
  configPath?: string;
}

export class McpConnectionManager {
  private readonly config: McpConfigFile;
  private readonly options: McpConnectionManagerOptions;
  private readonly sessions = new Map<string, McpClientSession>();
  private readonly defaultServerName: string | undefined;

  constructor(config: McpConfigFile = parseConfigOrDefault(), options: McpConnectionManagerOptions = {}) {
    this.config = config;
    this.options = options;
    this.defaultServerName = resolveDefaultMcpServerName(config);
  }

  getAvailableServerNames(): string[] {
    return getEnabledMcpServers(this.config).map((server) => server.name);
  }

  getConfiguredServerNames(): string[] {
    return getAllMcpServers(this.config).map((server) => server.name);
  }

  getServerConfig(name?: string): McpServerConfig {
    const serverName = this.resolveServerName(name);
    const config = getAllMcpServers(this.config).find((server) => server.name === serverName);
    if (!config) {
      const available = this.getAvailableServerNames().join(", ") || "(none)";
      throw new Error(`MCP server "${serverName}" not found. Available: ${available}`);
    }
    if (config.enabled === false) {
      throw new Error(`MCP server "${serverName}" is disabled`);
    }
    return { ...config, args: [...(config.args ?? [])], env: config.env ? { ...config.env } : undefined };
  }

  async connect(name?: string): Promise<McpClientSession> {
    const serverConfig = this.getServerConfig(name);
    const session = this.ensureSession(serverConfig);
    await session.initialize();
    return session;
  }

  async ping(name?: string): Promise<void> {
    const session = await this.connect(name);
    await session.ping();
  }

  async listTools(name?: string): Promise<McpToolInventoryEntry[]> {
    if (name) {
      return (await this.connect(name)).listTools();
    }

    if (this.defaultServerName) {
      return (await this.connect(this.defaultServerName)).listTools();
    }

    const all: McpToolInventoryEntry[] = [];
    for (const server of getEnabledMcpServers(this.config)) {
      const tools = await this.connect(server.name).then((session) => session.listTools());
      all.push(...tools);
    }
    return all;
  }

  async listResources(name?: string, refresh = false): Promise<McpResourceInventoryEntry[]> {
    if (name) {
      return (await this.connect(name)).listResources(refresh);
    }

    const all: McpResourceInventoryEntry[] = [];
    for (const server of getEnabledMcpServers(this.config)) {
      const resources = await this.connect(server.name).then((session) => session.listResources(refresh));
      all.push(...resources);
    }
    return all;
  }

  async listAllTools(): Promise<McpToolInventoryEntry[]> {
    return this.listTools(undefined);
  }

  async listAllResources(refresh = false): Promise<McpResourceInventoryEntry[]> {
    return this.listResources(undefined, refresh);
  }

  async callTool(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<McpToolCallResponse> {
    const session = await this.connect(serverName);
    return session.callTool(toolName, input);
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceReadResponse> {
    const session = await this.connect(serverName);
    return session.readResource(uri);
  }

  async refreshTools(name?: string): Promise<McpToolInventoryEntry[]> {
    if (name) {
      return (await this.connect(name)).refreshTools();
    }

    const all: McpToolInventoryEntry[] = [];
    for (const server of getEnabledMcpServers(this.config)) {
      const tools = await this.connect(server.name).then((session) => session.refreshTools());
      all.push(...tools);
    }
    return all;
  }

  async refreshResources(name?: string): Promise<McpResourceInventoryEntry[]> {
    return this.listResources(name, true);
  }

  async close(name?: string): Promise<void> {
    if (name) {
      const session = this.sessions.get(name);
      if (session) {
        await session.close();
        this.sessions.delete(name);
      }
      return;
    }

    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }

  getDefaultServerName(): string | undefined {
    return this.defaultServerName;
  }

  getStatusSnapshot(): McpConnectionManagerStatusSnapshot {
    const selection = resolveMcpServerSelection(this.config);
    const sessions = new Map(this.sessions);
    const servers = getAllMcpServers(this.config).map((server) => {
      const session = sessions.get(server.name);
      const snapshot = session ? session.getStatusSnapshot() : {
        serverName: server.name,
        enabled: server.enabled !== false,
        state: "idle" as const,
        toolCount: undefined,
        resourceCount: undefined,
        lastError: undefined,
        lastInitializedAt: undefined,
        lastToolRefreshAt: undefined,
        lastResourceRefreshAt: undefined,
        serverInfo: undefined,
        transport: undefined,
      };

      return {
        ...snapshot,
        enabled: server.enabled !== false,
      };
    });

    return {
      defaultServerName: this.defaultServerName,
      selection,
      servers,
    };
  }

  private ensureSession(config: McpServerConfig): McpClientSession {
    const existing = this.sessions.get(config.name);
    if (existing) {
      return existing;
    }

    const session = new McpClientSession(config, {
      ...this.options,
      transport: this.options.transportFactory ? this.options.transportFactory(config) : undefined,
    });
    this.sessions.set(config.name, session);
    return session;
  }

  private resolveServerName(name?: string): string {
    const selection = resolveMcpServerSelection(this.config, name);
    if (selection.state === "disabled") {
      throw new Error(selection.reason);
    }
    if (selection.selectedServerName) {
      return selection.selectedServerName;
    }
    throw new Error(selection.reason);
  }
}

function normalizeMcpResourceInventoryEntry(
  serverName: string,
  resource: McpResourceDescriptor,
  serverInfo?: McpServerInfo,
): McpResourceInventoryEntry {
  return {
    ...resource,
    serverName,
    serverTitle: serverInfo?.title ?? serverInfo?.name,
    qualifiedUri: `${serverName}:${resource.uri}`,
  };
}

function normalizeMcpResourceInventory(
  serverName: string,
  resources: unknown[],
  serverInfo?: McpServerInfo,
): McpResourceInventoryEntry[] {
  return resources
    .filter(isMcpResourceDescriptor)
    .map((resource) => normalizeMcpResourceInventoryEntry(serverName, resource, serverInfo));
}

function isMcpResourceDescriptor(value: unknown): value is McpResourceDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { uri?: unknown }).uri === "string" &&
    (value as { uri: string }).uri.trim().length > 0
  );
}

function normalizeMcpReadResourceResult(result: McpReadResourceResult): McpReadResourceResult {
  const contents = Array.isArray(result?.contents)
    ? result.contents.filter(isMcpResourceContents)
    : [];
  return { contents };
}

function isMcpResourceContents(value: unknown): value is McpReadResourceResult["contents"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.uri !== "string") {
    return false;
  }
  return typeof record.text === "string" || typeof record.blob === "string";
}

function renderMcpReadResourceResult(result: McpReadResourceResult): string {
  const rendered = result.contents.map((content) => {
    if ("text" in content) {
      return content.text;
    }
    const mime = content.mimeType ? `, ${content.mimeType}` : "";
    return `[blob resource: ${content.uri}${mime}, base64 length ${content.blob.length}]`;
  });

  return rendered.length > 0 ? rendered.join("\n") : "[No resource contents]";
}

function parseConfigOrDefault(): McpConfigFile {
  const loaded = loadMcpConfig();
  return loaded;
}
