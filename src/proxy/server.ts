/**
 * Local LLM proxy — exposes Anthropic / OpenAI-compatible HTTP endpoints
 * over a registered `ProviderRegistry`. Upstream tools (Claude Code, Codex
 * CLI, Gemini CLI clones, etc.) point at this server and get routed to
 * whichever backend is available.
 *
 * Exposed endpoints:
 *   GET  /health                         → liveness + provider inventory
 *   GET  /v1/providers                   → list registered providers
 *   GET  /v2/capabilities                → proxy discovery + provider caps
 *   POST /v2/batch                       → batch multiple proxy requests
 *   POST /anthropic/v1/messages          → Anthropic Messages API compat
 *   POST /openai/v1/chat/completions     → OpenAI Chat Completions compat
 *   POST /openai/v1/responses            → OpenAI Responses API compat (Codex)
 *   POST /v1/messages                    → same as /anthropic/v1/messages
 *   POST /v1/chat/completions            → same as /openai/v1/chat/completions
 *   POST /v1/responses                   → same as /openai/v1/responses
 *
 * All streaming endpoints return `text/event-stream`. Non-streaming return JSON.
 *
 * Runtime: Bun. Built on top of Bun.serve — no external HTTP deps.
 */

import {
  isHostedToolDefinition,
  type ProviderRegistry,
  type ToolDefinition,
} from "../providers/types.js";
import { pickProvider } from "./router.js";
import {
  buildProxyCapabilities,
  ProxyBatchRequestSchema,
  type ProxyBatchRequestItem,
  type ProxyBatchResponse,
} from "./v2.js";
import { handleCorelineHook } from "./hooks.js";
import { createSseStream, encodeSseEvent } from "./sse.js";
import { handleA2ARequest } from "./a2a.js";
import { createStatusStream } from "./status-stream.js";
import { handleDashboardRequest } from "../dashboard/index.js";
import { readStatusSnapshot, type AgentStatusSnapshot, type StatusTracker } from "../agent/status.js";
import {
  toChatRequest as anthropicToChatRequest,
  buildNonStreamingResponse as anthropicBuildResponse,
  toAnthropicSseEvents,
  type AnthropicMessagesRequest,
} from "./mapper-anthropic.js";
import {
  toChatRequest as openaiChatToChatRequest,
  buildNonStreamingResponse as openaiChatBuildResponse,
  toOpenAiChatSseChunks,
  type OpenAIChatRequest,
} from "./mapper-openai-chat.js";
import {
  toChatRequest as openaiResponsesToChatRequest,
  buildNonStreamingResponse as openaiResponsesBuildResponse,
  toResponsesSseEvents,
  type ResponsesRequest,
} from "./mapper-openai-responses.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProxyServerConfig {
  registry: ProviderRegistry;
  port?: number;
  host?: string;
  /** Require this bearer token in `Authorization` header (optional) */
  authToken?: string;
  /** Maximum batch items allowed in a single request */
  maxBatchItems?: number;
  /** Maximum concurrent batch items */
  maxBatchConcurrency?: number;
  /** Per-item batch timeout in milliseconds */
  batchTimeoutMs?: number;
  /** Optional live status tracker used by /v2/status */
  statusTracker?: StatusTracker;
  /** Optional status file fallback used by /v2/status */
  statusPath?: string;
  /** Log callback (default: console.log) */
  log?: (line: string) => void;
}

export interface ProxyServerHandle {
  port: number;
  host: string;
  url: string;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startProxyServer(config: ProxyServerConfig): ProxyServerHandle {
  const port = config.port ?? Number(process.env.PROXY_PORT ?? 4317);
  const host = config.host ?? process.env.PROXY_HOST ?? "127.0.0.1";
  const log = config.log ?? ((line: string) => console.log(line));
  const requiredToken = config.authToken ?? process.env.PROXY_AUTH_TOKEN;

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const requestId = getRequestId(req);
      return await dispatchProxyRequest(req, config, log, { requiredToken, requestId });
    },
    error(err) {
      log(`[proxy] server error: ${err.message}`);
      return jsonError(500, "internal_error", err.message);
    },
  });

  const handle: ProxyServerHandle = {
    port: server.port ?? port,
    host,
    url: `http://${host}:${server.port ?? port}`,
    stop() {
      server.stop(true);
    },
  };

  log(`[proxy] listening on ${handle.url}`);
  log(`[proxy] providers: ${config.registry.listProviders().join(", ") || "(none)"}`);
  log(`[proxy] default:  ${safeGetDefaultName(config.registry) ?? "(none)"}`);
  log(`[proxy] auth: ${requiredToken ? "required" : "disabled"}`);
  log(
    `[proxy] batch limits: maxItems=${getMaxBatchItems(config)}, maxConcurrency=${getMaxBatchConcurrency(config)}, timeoutMs=${getBatchTimeoutMs(config)}`,
  );
  log(`[proxy] request tracing: X-Request-Id enabled`);

  return handle;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function dispatchProxyRequest(
  req: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  options?: { requiredToken?: string; skipAuth?: boolean; requestId?: string },
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const requiredToken = options?.requiredToken ?? config.authToken ?? process.env.PROXY_AUTH_TOKEN;
  const requestId = options?.requestId ?? getRequestId(req);
  const trace = `[proxy ${requestId}] ${req.method} ${pathname}`;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return attachRequestId(new Response(null, { headers: corsHeaders() }), requestId);
  }

  // Optional bearer-token auth
  if (!options?.skipAuth && requiredToken && !isAuthorized(req, requiredToken)) {
    log(`${trace} auth=unauthorized`);
    return jsonError(401, "unauthorized", "Invalid or missing bearer token", requestId);
  }

  try {
    // Health + listing endpoints
    if (req.method === "GET" && pathname === "/health") {
      log(`${trace} route=/health`);
      const response = Response.json(
        {
          status: "ok",
          providers: config.registry.listProviders(),
          default: safeGetDefaultName(config.registry),
        },
        { headers: corsHeaders() },
      );
      return attachRequestId(response, requestId);
    }

    if (req.method === "GET" && pathname === "/v1/providers") {
      log(`${trace} route=/v1/providers`);
      const names = config.registry.listProviders();
      const list = names.map((name) => {
        const p = config.registry.getProvider(name);
        return {
          name,
          type: p.type,
          model: p.model,
          supportsToolCalling: p.supportsToolCalling,
          supportsStreaming: p.supportsStreaming,
        };
      });
      return attachRequestId(Response.json({ providers: list }, { headers: corsHeaders() }), requestId);
    }

    if (req.method === "GET" && (pathname === "/v2/capabilities" || pathname === "/v1/capabilities")) {
      log(`${trace} route=${pathname}`);
      return attachRequestId(
        Response.json(
          buildProxyCapabilities(config.registry, {
            authRequired: Boolean(requiredToken),
            requestTracing: true,
            batchLimit: getMaxBatchItems(config),
            batchConcurrency: getMaxBatchConcurrency(config),
            batchTimeoutMs: getBatchTimeoutMs(config),
            status: true,
          }),
          { headers: corsHeaders() },
        ),
        requestId,
      );
    }

    if (req.method === "GET" && (pathname === "/v2/status" || pathname === "/v1/status")) {
      log(`${trace} route=${pathname}`);
      return attachRequestId(Response.json(buildStatusResponse(config), { headers: corsHeaders() }), requestId);
    }

    if (req.method === "GET" && pathname === "/v2/status/stream") {
      log(`${trace} route=/v2/status/stream`);
      if (!config.statusTracker) {
        return jsonError(503, "status_stream_unavailable", "A live StatusTracker is required for SSE status stream", requestId);
      }
      return attachRequestId(createStatusStream(config.statusTracker).response, requestId);
    }

    if (req.method === "GET" && pathname === "/dashboard") {
      log(`${trace} route=/dashboard`);
      return attachRequestId(
        handleDashboardRequest({
          status: config.statusTracker?.get() ?? readStatusSnapshot(config.statusPath),
          statusPath: "/v2/status",
          streamPath: "/v2/status/stream",
        }),
        requestId,
      );
    }

    if (
      (req.method === "GET" && pathname === "/.well-known/agent.json") ||
      (req.method === "POST" && pathname === "/a2a/tasks/send")
    ) {
      log(`${trace} route=${pathname}`);
      return attachRequestId(await handleA2ARequest(req), requestId);
    }

    if (req.method === "POST" && pathname === "/hook/coreline/start") {
      log(`${trace} route=/hook/coreline/start`);
      return attachRequestId(await handleCorelineHook(req, config, "start"), requestId);
    }

    if (req.method === "POST" && pathname === "/hook/coreline/stop") {
      log(`${trace} route=/hook/coreline/stop`);
      return attachRequestId(await handleCorelineHook(req, config, "stop"), requestId);
    }

    if (req.method === "POST" && pathname === "/hook/coreline/idle") {
      log(`${trace} route=/hook/coreline/idle`);
      return attachRequestId(await handleCorelineHook(req, config, "idle"), requestId);
    }

    if (req.method === "POST" && (pathname === "/v2/batch" || pathname === "/v1/batch")) {
      log(`${trace} route=${pathname}`);
      return await handleBatch(req, config, log, requestId);
    }

    // Anthropic Messages API
    if (
      req.method === "POST" &&
      (pathname === "/anthropic/v1/messages" || pathname === "/v1/messages")
    ) {
      return await handleAnthropic(req, config, log, requestId);
    }

    // OpenAI Chat Completions
    if (
      req.method === "POST" &&
      (pathname === "/openai/v1/chat/completions" ||
        pathname === "/v1/chat/completions")
    ) {
      return await handleOpenAiChat(req, config, log, requestId);
    }

    // OpenAI Responses (Codex CLI uses this)
    if (
      req.method === "POST" &&
      (pathname === "/openai/v1/responses" || pathname === "/v1/responses")
    ) {
      return await handleOpenAiResponses(req, config, log, requestId);
    }

    return jsonError(404, "not_found", `No handler for ${req.method} ${pathname}`, requestId);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(`${trace} error=${message}`);
    return jsonError(500, "internal_error", message, requestId);
  }
}


function buildStatusResponse(config: ProxyServerConfig): {
  type: "agent_status";
  available: boolean;
  status: AgentStatusSnapshot | null;
  hooks: { start: string; stop: string; idle: string };
} {
  const status = config.statusTracker?.get() ?? readStatusSnapshot(config.statusPath);
  return {
    type: "agent_status",
    available: Boolean(status),
    status,
    hooks: {
      start: "/hook/coreline/start",
      stop: "/hook/coreline/stop",
      idle: "/hook/coreline/idle",
    },
  };
}

async function handleBatch(
  req: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  requestId: string,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "invalid_batch_request", "Batch body must be valid JSON", requestId);
  }

  const parsed = ProxyBatchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    return jsonError(400, "invalid_batch_request", message || "Invalid batch request", requestId);
  }

  const maxItems = getMaxBatchItems(config);
  if (parsed.data.requests.length > maxItems) {
    return jsonError(
      413,
      "batch_limit_exceeded",
      `Batch contains ${parsed.data.requests.length} requests; limit is ${maxItems}`,
      requestId,
    );
  }

  const results = await executeBatchItems(parsed.data.requests, req, config, log, requestId);
  const payload: ProxyBatchResponse = {
    type: "batch_response",
    count: results.length,
    requestId,
    results,
  };
  return attachRequestId(Response.json(payload, { headers: corsHeaders() }), requestId);
}

async function executeBatchItem(
  item: ProxyBatchRequestItem,
  index: number,
  parentReq: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  requestId: string,
): Promise<ProxyBatchResponse["results"][number]> {
  log(`[proxy ${requestId}] batch item ${item.method} ${item.path}`);

  if (containsStreamingFlag(item)) {
    const errorResponse = jsonError(
      400,
      "unsupported_batch_streaming",
      "Batch items do not support stream=true",
      requestId,
    );
    return {
      id: item.id ?? String(index),
      method: item.method,
      path: item.path,
      status: errorResponse.status,
      ok: errorResponse.ok,
      requestId,
      body: await readResponseBody(errorResponse),
    };
  }

  const timeoutMs = getBatchTimeoutMs(config);
  const controller = new AbortController();
  const internalRequest = buildInternalRequest(item, parentReq.url, controller.signal);
  let timeoutHit = false;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutId = setTimeout(() => {
    timeoutHit = true;
    controller.abort();
    rejectTimeout?.(new Error("batch item timeout"));
  }, timeoutMs);

  try {
    const response = await Promise.race([
      dispatchProxyRequest(internalRequest, config, log, {
        skipAuth: true,
        requestId,
      }),
      timeoutPromise,
    ]);
    return {
      id: item.id ?? String(index),
      method: item.method,
      path: item.path,
      status: response.status,
      ok: response.ok,
      requestId,
      body: await readResponseBody(response),
    };
  } catch (error) {
    if (timeoutHit) {
      const timeoutResponse = jsonError(
        504,
        "batch_item_timeout",
        `Batch item exceeded ${timeoutMs}ms timeout`,
        requestId,
      );
      return {
        id: item.id ?? String(index),
        method: item.method,
        path: item.path,
        status: timeoutResponse.status,
        ok: timeoutResponse.ok,
        requestId,
        body: await readResponseBody(timeoutResponse),
      };
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeBatchItems(
  items: ProxyBatchRequestItem[],
  parentReq: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  requestId: string,
): Promise<ProxyBatchResponse["results"]> {
  const maxConcurrency = Math.max(1, getMaxBatchConcurrency(config));
  const results: ProxyBatchResponse["results"] = new Array(items.length);
  let nextIndex = 0;

  async function worker(workerIndex: number): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }

      const item = items[current]!;
      const itemRequestId = `${requestId}.b${current + 1}`;
      results[current] = await executeBatchItem(item, current, parentReq, config, log, itemRequestId);
      void workerIndex;
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, (_, index) =>
    worker(index),
  );
  await Promise.all(workers);
  return results;
}

function buildInternalRequest(item: ProxyBatchRequestItem, baseUrl: string, signal?: AbortSignal): Request {
  const headers = new Headers(item.headers ?? {});
  const init: RequestInit = { method: item.method, headers, signal };

  if (!["GET", "HEAD", "OPTIONS"].includes(item.method) && item.body !== undefined) {
    if (typeof item.body === "string") {
      init.body = item.body;
    } else {
      init.body = JSON.stringify(item.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  return new Request(new URL(item.path, baseUrl), init);
}

function containsStreamingFlag(item: ProxyBatchRequestItem): boolean {
  return Boolean(
    item.body &&
      typeof item.body === "object" &&
      !Array.isArray(item.body) &&
      "stream" in item.body &&
      (item.body as { stream?: unknown }).stream === true,
  );
}

type HumanInputModePolicy = "return" | "forbid" | "invalid" | undefined;

function getHumanInputModePolicy(body: unknown): HumanInputModePolicy {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const rec = body as Record<string, unknown>;
  const raw = rec.human_input_mode ?? rec.humanInputMode ?? rec.humanInput;
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw === "string") {
    if (raw === "return") return "return";
    if (raw === "forbid") return "forbid";
    if (raw === "enabled" || raw === "true" || raw === "interactive") return "return";
    if (raw === "disabled" || raw === "false") return "forbid";
    return "invalid";
  }

  if (typeof raw === "boolean") {
    return raw ? "return" : "forbid";
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const mode = (raw as Record<string, unknown>).mode ?? (raw as Record<string, unknown>).policy ?? (raw as Record<string, unknown>).value;
    if (mode === "return") return "return";
    if (mode === "forbid") return "forbid";
  }

  return "invalid";
}

function isInteractiveHostedToolDefinition(tool: ToolDefinition): boolean {
  if (!isHostedToolDefinition(tool)) {
    return false;
  }

  return (
    tool.name === "web_search" ||
    tool.name === "code_execution" ||
    tool.name === "code_interpreter" ||
    tool.toolType === "web_search_20250305" ||
    tool.toolType === "code_execution_20250825" ||
    tool.toolType === "web_search" ||
    tool.toolType === "code_execution" ||
    tool.toolType === "code_interpreter"
  );
}

function getInteractiveHostedToolNames(tools: ToolDefinition[] | undefined): string[] {
  if (!tools) {
    return [];
  }

  return tools.filter(isInteractiveHostedToolDefinition).map((tool) => tool.name);
}

function rejectUnsupportedHumanInputMode(requestId: string): Response {
  return jsonError(
    400,
    "unsupported_human_input_mode",
    "human_input_mode is not supported by the proxy; use an interactive client instead.",
    requestId,
  );
}

function humanInputRequiredResponse(requestId: string, tools: string[]): Response {
  const toolList = tools.length > 0 ? ` for interactive hosted tools: ${tools.join(", ")}` : "";
  return jsonError(
    409,
    "human_input_required",
    `human_input_mode=return requires user interaction${toolList}.`,
    requestId,
  );
}

function surfaceErrorMessage(error: unknown, requestId: string): string {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec.message === "string" && rec.message.trim()) {
      return rec.message.trim();
    }
  }

  return `upstream error in request ${requestId}`;
}

function surfaceProviderError(error: unknown, requestId: string): Response {
  const message = surfaceErrorMessage(error, requestId);
  if (/human_input_mode is not supported/i.test(message)) {
    return jsonError(400, "unsupported_human_input_mode", message, requestId);
  }
  if (/hosted tool .+ is not supported/i.test(message)) {
    return jsonError(400, "unsupported_hosted_tool", message, requestId);
  }
  if (/does not support streaming/i.test(message)) {
    return jsonError(400, "unsupported_provider_streaming", message, requestId);
  }
  return jsonError(502, "upstream_error", message, requestId);
}

function getRequestId(req: Request): string {
  return req.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}

function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getMaxBatchItems(config: ProxyServerConfig): number {
  return Math.max(1, config.maxBatchItems ?? Number(process.env.PROXY_MAX_BATCH_ITEMS ?? 8));
}

function getMaxBatchConcurrency(config: ProxyServerConfig): number {
  return Math.max(1, config.maxBatchConcurrency ?? Number(process.env.PROXY_MAX_BATCH_CONCURRENCY ?? 4));
}

function getBatchTimeoutMs(config: ProxyServerConfig): number {
  return Math.max(250, config.batchTimeoutMs ?? Number(process.env.PROXY_BATCH_TIMEOUT_MS ?? 30_000));
}

async function readResponseBody(response: Response): Promise<unknown> {
  const clone = response.clone();
  const contentType = clone.headers.get("content-type") ?? "";
  if (!clone.body) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return await clone.json();
    } catch {
      return await clone.text();
    }
  }

  const text = await clone.text();
  return text.length > 0 ? text : null;
}

async function handleAnthropic(
  req: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  requestId: string,
): Promise<Response> {
  const body = (await req.json()) as AnthropicMessagesRequest;
  const picked = pickProvider(config.registry, body.model);
  const trace = `[proxy ${requestId}] POST /anthropic/v1/messages model=${body.model} → ${picked.provider.name} (${picked.matchedBy})`;
  log(trace);

  let chatRequest;
  try {
    chatRequest = anthropicToChatRequest(body, req.signal);
  } catch (error) {
    return surfaceProviderError(error, requestId);
  }

  const humanInputMode = getHumanInputModePolicy(body);
  if (humanInputMode === "return") {
    const interactiveHostedTools = getInteractiveHostedToolNames(chatRequest.tools);
    if (interactiveHostedTools.length > 0) {
      return humanInputRequiredResponse(requestId, interactiveHostedTools);
    }
  }
  if (humanInputMode !== undefined) {
    return rejectUnsupportedHumanInputMode(requestId);
  }

  if (body.stream && !picked.provider.supportsStreaming) {
    return jsonError(
      400,
      "unsupported_provider_streaming",
      `Provider "${picked.provider.name}" does not support streaming responses.`,
      requestId,
    );
  }

  const responseModel = body.model || picked.provider.model;

  if (body.stream) {
    const { response, writer } = createSseStream();
    void (async () => {
      try {
        const chunks = picked.provider.send(chatRequest);
        for await (const evt of toAnthropicSseEvents(responseModel, chunks)) {
          writer.writeEvent(evt.event, evt.data);
        }
      } catch (err) {
        writer.writeEvent("error", {
          type: "error",
          error: {
            type: "api_error",
            message: surfaceErrorMessage(err, requestId),
          },
        });
      } finally {
        writer.close();
      }
    })();
    return attachRequestId(new Response(response, { headers: sseHeaders() }), requestId);
  }

  try {
    const payload = await anthropicBuildResponse(
      responseModel,
      picked.provider.send(chatRequest),
    );
    return attachRequestId(Response.json(payload, { headers: corsHeaders() }), requestId);
  } catch (error) {
    return surfaceProviderError(error, requestId);
  }
}

async function handleOpenAiChat(
  req: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  requestId: string,
): Promise<Response> {
  const body = (await req.json()) as OpenAIChatRequest;
  const picked = pickProvider(config.registry, body.model);
  log(`[proxy ${requestId}] POST /openai/v1/chat/completions model=${body.model} → ${picked.provider.name} (${picked.matchedBy})`);

  let chatRequest;
  try {
    chatRequest = openaiChatToChatRequest(body, req.signal);
  } catch (error) {
    return surfaceProviderError(error, requestId);
  }

  const humanInputMode = getHumanInputModePolicy(body);
  if (humanInputMode === "return") {
    const interactiveHostedTools = getInteractiveHostedToolNames(chatRequest.tools);
    if (interactiveHostedTools.length > 0) {
      return humanInputRequiredResponse(requestId, interactiveHostedTools);
    }
  }
  if (humanInputMode !== undefined) {
    return rejectUnsupportedHumanInputMode(requestId);
  }

  if (body.stream && !picked.provider.supportsStreaming) {
    return jsonError(
      400,
      "unsupported_provider_streaming",
      `Provider "${picked.provider.name}" does not support streaming responses.`,
      requestId,
    );
  }

  const responseModel = body.model || picked.provider.model;

  if (body.stream) {
    const { response, writer } = createSseStream();
    void (async () => {
      try {
        const chunks = picked.provider.send(chatRequest);
        for await (const payload of toOpenAiChatSseChunks(responseModel, chunks)) {
          if (payload === "[DONE]") {
            writer.writeEvent(null, "[DONE]");
          } else {
            writer.writeEvent(null, payload);
          }
        }
      } catch (err) {
        writer.writeEvent(null, {
          error: { type: "api_error", message: surfaceErrorMessage(err, requestId) },
        });
      } finally {
        writer.close();
      }
    })();
    return attachRequestId(new Response(response, { headers: sseHeaders() }), requestId);
  }

  try {
    const payload = await openaiChatBuildResponse(
      responseModel,
      picked.provider.send(chatRequest),
    );
    return attachRequestId(Response.json(payload, { headers: corsHeaders() }), requestId);
  } catch (error) {
    return surfaceProviderError(error, requestId);
  }
}

async function handleOpenAiResponses(
  req: Request,
  config: ProxyServerConfig,
  log: (line: string) => void,
  requestId: string,
): Promise<Response> {
  const body = (await req.json()) as ResponsesRequest;
  const picked = pickProvider(config.registry, body.model);
  log(`[proxy ${requestId}] POST /openai/v1/responses model=${body.model} → ${picked.provider.name} (${picked.matchedBy})`);

  let chatRequest;
  try {
    chatRequest = openaiResponsesToChatRequest(body, req.signal);
  } catch (error) {
    return surfaceProviderError(error, requestId);
  }

  const humanInputMode = getHumanInputModePolicy(body);
  if (humanInputMode === "return") {
    const interactiveHostedTools = getInteractiveHostedToolNames(chatRequest.tools);
    if (interactiveHostedTools.length > 0) {
      return humanInputRequiredResponse(requestId, interactiveHostedTools);
    }
  }
  if (humanInputMode !== undefined) {
    return rejectUnsupportedHumanInputMode(requestId);
  }

  if (body.stream && !picked.provider.supportsStreaming) {
    return jsonError(
      400,
      "unsupported_provider_streaming",
      `Provider "${picked.provider.name}" does not support streaming responses.`,
      requestId,
    );
  }

  const responseModel = body.model || picked.provider.model;

  if (body.stream) {
    const { response, writer } = createSseStream();
    void (async () => {
      try {
        const chunks = picked.provider.send(chatRequest);
        for await (const evt of toResponsesSseEvents(responseModel, chunks)) {
          writer.writeEvent(evt.event, evt.data);
        }
      } catch (err) {
        writer.writeEvent("error", {
          type: "error",
          error: { type: "api_error", message: surfaceErrorMessage(err, requestId) },
        });
      } finally {
        writer.close();
      }
    })();
    return attachRequestId(new Response(response, { headers: sseHeaders() }), requestId);
  }

  try {
    const payload = await openaiResponsesBuildResponse(
      responseModel,
      picked.provider.send(chatRequest),
    );
    return attachRequestId(Response.json(payload, { headers: corsHeaders() }), requestId);
  } catch (error) {
    return surfaceProviderError(error, requestId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, anthropic-version, anthropic-beta, openai-beta, x-api-key",
  };
}

function sseHeaders(): HeadersInit {
  return {
    ...corsHeaders(),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

function jsonError(status: number, code: string, message: string, requestId?: string): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: code, message },
      requestId,
    }),
    {
      status,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    },
  );
}

function isAuthorized(req: Request, token: string): boolean {
  const auth =
    req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
  const trimmed = auth.replace(/^Bearer\s+/i, "").trim();
  return trimmed === token;
}

function safeGetDefaultName(registry: ProviderRegistry): string | undefined {
  try {
    return registry.getDefault().name;
  } catch {
    return undefined;
  }
}

// Re-export for convenience
export { encodeSseEvent };
