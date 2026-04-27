import type { AgentStatusSnapshot } from "../agent/status.js";

export type A2ATaskStatus = "accepted" | "disabled" | "rejected";

export interface AgentCardEndpoint {
  name: string;
  method: "GET" | "POST";
  path: string;
  description?: string;
}

export interface AgentCard {
  type: "agent_card";
  name: string;
  version: string;
  description: string;
  protocol: "coreline-a2a";
  endpoints: AgentCardEndpoint[];
  capabilities: {
    taskSend: boolean;
    taskExecution: "adapter-only" | "disabled";
    statusStream: boolean;
    dashboard: boolean;
  };
}

export interface A2ATaskMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface A2ATaskRequest {
  id?: string;
  taskId?: string;
  input: string | A2ATaskMessage[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskResponse {
  type: "a2a_task_response";
  status: A2ATaskStatus;
  taskId: string;
  message: string;
  acceptedAt?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type StatusStreamEventName = "snapshot" | "status" | "keepalive" | "error";

export interface StatusStreamEvent {
  type: "status_stream_event";
  event: StatusStreamEventName;
  timestamp: string;
  status?: AgentStatusSnapshot;
  message?: string;
}

export type ClideckAgentState =
  | "idle"
  | "working"
  | "blocked"
  | "waiting_user"
  | "completed"
  | "failed"
  | "aborted"
  | "offline";

export interface ClideckAgentEvent {
  type: "clideck_agent_event";
  agent: "coreline-agent";
  state: ClideckAgentState;
  timestamp: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  message?: string;
  rawStatus?: AgentStatusSnapshot;
}

export interface ClideckTaskResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  artifacts?: Array<{
    name: string;
    kind: "text" | "file" | "url" | "json";
    content?: string;
    path?: string;
    url?: string;
    data?: unknown;
  }>;
  metadata?: Record<string, unknown>;
}

export interface CorelineArtifact {
  type: "coreline_artifact";
  source: "clideck";
  taskId: string;
  status: ClideckTaskResult["status"];
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export function createDefaultAgentCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    type: "agent_card",
    name: "coreline-agent",
    version: "0.1.0",
    description: "Local multi-provider coding agent proxy with adapter-only A2A task intake.",
    protocol: "coreline-a2a",
    endpoints: [
      { name: "agent-card", method: "GET", path: "/.well-known/agent.json", description: "A2A discovery card" },
      { name: "task-send", method: "POST", path: "/a2a/tasks/send", description: "Adapter-only task intake" },
      { name: "status", method: "GET", path: "/v2/status", description: "Current agent status snapshot" },
      { name: "status-stream", method: "GET", path: "/v2/status/stream", description: "SSE status stream" },
      { name: "dashboard", method: "GET", path: "/dashboard", description: "Read-only dashboard shell" },
    ],
    capabilities: {
      taskSend: true,
      taskExecution: "adapter-only",
      statusStream: true,
      dashboard: true,
    },
    ...overrides,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateAgentCard(value: unknown): value is AgentCard {
  if (!isRecord(value)) return false;
  return value.type === "agent_card"
    && typeof value.name === "string"
    && typeof value.version === "string"
    && typeof value.description === "string"
    && value.protocol === "coreline-a2a"
    && Array.isArray(value.endpoints)
    && isRecord(value.capabilities);
}

export function normalizeA2ATaskRequest(value: unknown): A2ATaskRequest | null {
  if (!isRecord(value)) return null;
  const input = value.input;
  if (typeof input !== "string" && !isA2AMessageArray(input)) return null;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined,
    taskId: typeof value.taskId === "string" && value.taskId.trim() ? value.taskId.trim() : undefined,
    input,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

export function validateA2ATaskRequest(value: unknown): value is A2ATaskRequest {
  return normalizeA2ATaskRequest(value) !== null;
}

export function validateA2ATaskResponse(value: unknown): value is A2ATaskResponse {
  if (!isRecord(value)) return false;
  return value.type === "a2a_task_response"
    && isA2ATaskStatus(value.status)
    && typeof value.taskId === "string"
    && typeof value.message === "string";
}

export function validateStatusStreamEvent(value: unknown): value is StatusStreamEvent {
  if (!isRecord(value)) return false;
  return value.type === "status_stream_event"
    && isStatusStreamEventName(value.event)
    && typeof value.timestamp === "string";
}

export function validateClideckTaskResult(value: unknown): value is ClideckTaskResult {
  if (!isRecord(value)) return false;
  const status = value.status;
  return typeof value.taskId === "string"
    && (status === "completed" || status === "failed" || status === "cancelled")
    && (value.artifacts === undefined || Array.isArray(value.artifacts));
}

export function isA2ATaskStatus(value: unknown): value is A2ATaskStatus {
  return value === "accepted" || value === "disabled" || value === "rejected";
}

export function isStatusStreamEventName(value: unknown): value is StatusStreamEventName {
  return value === "snapshot" || value === "status" || value === "keepalive" || value === "error";
}

function isA2AMessageArray(value: unknown): value is A2ATaskMessage[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => {
      if (!isRecord(entry)) return false;
      return (entry.role === "user" || entry.role === "assistant" || entry.role === "system")
        && typeof entry.content === "string";
    });
}
