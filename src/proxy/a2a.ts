import {
  createDefaultAgentCard,
  normalizeA2ATaskRequest,
  type A2ATaskRequest,
  type A2ATaskResponse,
  type A2ATaskStatus,
  type AgentCard,
} from "./platform-types.js";

export interface A2ATaskAdapterResult {
  status: A2ATaskStatus;
  message?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type A2ATaskAdapter = (request: A2ATaskRequest) => A2ATaskAdapterResult | Promise<A2ATaskAdapterResult>;

export interface A2AHandlerOptions {
  agentCard?: AgentCard;
  taskAdapter?: A2ATaskAdapter;
  now?: () => Date;
}

export async function handleA2ARequest(req: Request, options: A2AHandlerOptions = {}): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
    return handleAgentCardRequest(options);
  }
  if (req.method === "POST" && url.pathname === "/a2a/tasks/send") {
    return handleA2ATaskSendRequest(req, options);
  }
  return json({ error: "not_found", message: "Unknown A2A route" }, 404);
}

export function handleAgentCardRequest(options: A2AHandlerOptions = {}): Response {
  return json(options.agentCard ?? createDefaultAgentCard(), 200);
}

export async function handleA2ATaskSendRequest(
  req: Request,
  options: A2AHandlerOptions = {},
): Promise<Response> {
  const body = await readJson(req);
  const task = normalizeA2ATaskRequest(body);
  if (!task) {
    return json(
      buildTaskResponse({
        taskId: "invalid",
        status: "rejected",
        message: "Invalid A2A task request",
        reason: "schema_validation_failed",
        now: options.now,
      }),
      400,
    );
  }

  const taskId = task.taskId ?? task.id ?? crypto.randomUUID();
  const adapter = options.taskAdapter ?? disabledAdapter;
  const result = await adapter({ ...task, taskId });
  const statusCode = result.status === "rejected" ? 400 : 202;
  return json(
    buildTaskResponse({
      taskId,
      status: result.status,
      message: result.message ?? defaultMessage(result.status),
      reason: result.reason,
      metadata: result.metadata,
      now: options.now,
    }),
    statusCode,
  );
}

export function buildTaskResponse(input: {
  taskId: string;
  status: A2ATaskStatus;
  message: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  now?: () => Date;
}): A2ATaskResponse {
  const response: A2ATaskResponse = {
    type: "a2a_task_response",
    status: input.status,
    taskId: input.taskId,
    message: input.message,
    acceptedAt: input.status === "accepted" ? (input.now ?? (() => new Date()))().toISOString() : undefined,
    reason: input.reason,
    metadata: input.metadata,
  };
  return compact(response);
}

function disabledAdapter(): A2ATaskAdapterResult {
  return {
    status: "disabled",
    message: "A2A task execution is disabled; request was accepted by the adapter boundary only.",
    reason: "execution_disabled",
  };
}

function defaultMessage(status: A2ATaskStatus): string {
  if (status === "accepted") return "A2A task accepted by adapter";
  if (status === "disabled") return "A2A task execution disabled";
  return "A2A task rejected";
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, x-request-id",
  };
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
