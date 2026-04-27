import { readStatusSnapshot, writeStatusSnapshot, type AgentStatus, type AgentStatusSnapshot, type StatusTracker } from "../agent/status.js";

export interface CorelineHookConfig {
  statusTracker?: StatusTracker;
  statusPath?: string;
}

type CorelineHookName = "start" | "stop" | "idle";

interface CorelineHookBody {
  sessionId?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  message?: string;
  turn?: number;
  resumeEligible?: boolean;
  status?: string;
  reason?: string;
  aborted?: boolean;
}

export async function handleCorelineHook(
  req: Request,
  config: CorelineHookConfig,
  hookName: CorelineHookName,
): Promise<Response> {
  const body = await readJsonBody(req);
  const snapshot = updateHookStatus(config, hookName, body);
  return Response.json(
    {
      type: "hook_ack",
      hook: hookName,
      status: snapshot.status,
      available: true,
      statusSnapshot: snapshot,
    },
    { headers: corsHeaders() },
  );
}

function updateHookStatus(
  config: CorelineHookConfig,
  hookName: CorelineHookName,
  body: CorelineHookBody,
): AgentStatusSnapshot {
  const existing = config.statusTracker?.get() ?? readStatusSnapshot(config.statusPath) ?? null;
  const status = resolveHookStatus(hookName, body);
  const now = new Date();
  const patch = {
    status,
    mode: normalizeMode(body.mode) ?? existing?.mode,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : existing?.sessionId,
    provider: typeof body.provider === "string" ? body.provider : existing?.provider,
    model: typeof body.model === "string" ? body.model : existing?.model,
    turn: typeof body.turn === "number" && Number.isFinite(body.turn) ? body.turn : existing?.turn,
    cwd: typeof body.cwd === "string" ? body.cwd : existing?.cwd,
    message: typeof body.message === "string" ? body.message : existing?.message,
    resumeEligible:
      typeof body.resumeEligible === "boolean" ? body.resumeEligible : existing?.resumeEligible,
  } satisfies Partial<AgentStatusSnapshot> & { status: AgentStatus };

  const snapshot: AgentStatusSnapshot = compactSnapshot({
    ...(existing ?? {
      status,
      lastActivity: now.toISOString(),
      pid: process.pid,
      startedAt: now.toISOString(),
      uptimeMs: 0,
    }),
    ...patch,
    lastActivity: now.toISOString(),
    pid: process.pid,
    startedAt: existing?.startedAt ?? now.toISOString(),
    uptimeMs: existing ? Math.max(0, now.getTime() - Date.parse(existing.startedAt)) : 0,
  });

  if (config.statusTracker) {
    config.statusTracker.update(patch);
  } else if (config.statusPath) {
    writeStatusSnapshot(config.statusPath, snapshot);
  }

  return snapshot;
}

function resolveHookStatus(hookName: CorelineHookName, body: CorelineHookBody): AgentStatus {
  if (hookName === "start") {
    return normalizeStatus(body.status) ?? "running";
  }
  if (hookName === "idle") {
    return normalizeStatus(body.status) ?? "idle";
  }

  if (body.aborted === true) {
    return "aborted";
  }

  const status = normalizeStatus(body.status);
  if (status === "aborted" || status === "exited") {
    return status;
  }

  if (typeof body.reason === "string") {
    const reason = body.reason.trim().toLowerCase();
    if (reason.includes("abort") || reason.includes("cancel")) {
      return "aborted";
    }
  }

  return "exited";
}

function normalizeStatus(value: unknown): AgentStatus | undefined {
  switch (value) {
    case "idle":
    case "planning":
    case "running":
    case "blocked":
    case "needs_user":
    case "completed":
    case "failed":
    case "aborted":
    case "exited":
      return value;
    default:
      return undefined;
  }
}

function normalizeMode(value: unknown): AgentStatusSnapshot["mode"] | undefined {
  switch (value) {
    case "chat":
    case "plan":
    case "goal":
    case "autopilot":
    case "proxy":
      return value;
    default:
      return undefined;
  }
}

function compactSnapshot(snapshot: AgentStatusSnapshot): AgentStatusSnapshot {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined),
  ) as AgentStatusSnapshot;
}

async function readJsonBody(req: Request): Promise<CorelineHookBody> {
  const contentLength = req.headers.get("content-length");
  if (contentLength === "0") {
    return {};
  }

  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    return raw as CorelineHookBody;
  } catch {
    return {};
  }
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, anthropic-version, anthropic-beta, openai-beta, x-api-key",
  };
}
