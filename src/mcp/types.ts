/**
 * MCP core types — config, protocol inventory, and connection contracts.
 */

import type { ToolDefinition } from "../providers/types.js";

export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-11-25";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
  enabled?: boolean;
  protocolVersion?: string;
}

export interface McpConfigFile {
  defaultServer?: string;
  servers: McpServerConfig[];
}

export type McpConfigLoadState = "loaded" | "missing" | "invalid";

export interface McpConfigLoadSnapshot {
  filePath: string;
  state: McpConfigLoadState;
  config: McpConfigFile;
  error?: string;
}

export type McpServerSelectionState = "selected" | "fallback" | "disabled" | "missing" | "none";

export interface McpServerSelectionSnapshot {
  requestedServerName?: string;
  selectedServerName?: string;
  defaultServerName?: string;
  enabledServerNames: string[];
  state: McpServerSelectionState;
  reason: string;
}

export interface McpServerInfo {
  name: string;
  title?: string;
  version?: string;
  description?: string;
  websiteUrl?: string;
}

export type McpConnectionState = "idle" | "connecting" | "ready" | "closed" | "error";

export interface McpTransportDiagnostics {
  kind: "stdio" | "custom";
  command?: string;
  args?: string[];
  stderrTail?: string;
}

export interface McpSessionStatusSnapshot {
  serverName: string;
  enabled: boolean;
  state: McpConnectionState;
  toolCount?: number;
  resourceCount?: number;
  lastError?: string;
  lastInitializedAt?: string;
  lastToolRefreshAt?: string;
  lastResourceRefreshAt?: string;
  serverInfo?: McpServerInfo;
  transport?: McpTransportDiagnostics;
}

export interface McpConnectionManagerStatusSnapshot {
  defaultServerName?: string;
  selection: McpServerSelectionSnapshot;
  servers: McpSessionStatusSnapshot[];
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: McpServerInfo;
  instructions?: string;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  title?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolInventoryEntry extends McpToolDescriptor {
  serverName: string;
  serverTitle?: string;
  qualifiedName: string;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
}

export interface McpResourceInventoryEntry extends McpResourceDescriptor {
  serverName: string;
  serverTitle?: string;
  qualifiedUri: string;
}

export interface McpListResourcesResult {
  resources?: McpResourceDescriptor[];
  nextCursor?: string;
}

export interface McpTextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface McpBlobResourceContents {
  uri: string;
  mimeType?: string;
  blob: string;
}

export type McpResourceContents = McpTextResourceContents | McpBlobResourceContents;

export interface McpReadResourceResult {
  contents: McpResourceContents[];
}

export interface McpResourceReadResponse {
  result: McpReadResourceResult;
  text: string;
}

export interface McpContentBlock {
  type?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpToolCallResponse {
  result: McpCallToolResult;
  text: string;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpTransportRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpTransport {
  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: McpTransportRequestOptions,
  ): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface McpClientSessionOptions {
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
    title?: string;
    description?: string;
  };
}

export interface McpConnectionManagerOptions extends McpClientSessionOptions {
  transportFactory?: (config: McpServerConfig) => McpTransport;
}

export interface McpToolBridgeOptions {
  namespace?: string;
}

export interface McpToolBridgeCallContext {
  toolName: string;
  inventory: McpToolInventoryEntry;
  input: Record<string, unknown>;
  result: McpCallToolResult;
}

export interface McpToolBridgeCallFn {
  (
    toolName: string,
    input: Record<string, unknown>,
    inventory: McpToolInventoryEntry,
  ): Promise<McpToolCallResponse>;
}

export type McpToolDefinition = ToolDefinition;
