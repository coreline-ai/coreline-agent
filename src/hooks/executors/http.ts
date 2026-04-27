import type { HookInput, HookResult, HttpHookConfig } from "../types.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export async function executeHttpHook(
  config: HttpHookConfig & { id: string },
  input: HookInput,
  signal?: AbortSignal,
): Promise<HookResult> {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const urlCheck = validateHookUrl(config.url, config.allowedHosts);
    if (!urlCheck.ok) {
      return errorResult(config, started, urlCheck.error);
    }

    if (config.timeoutMs && config.timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    }
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(input),
      signal: controller.signal,
      credentials: "omit",
    });

    if (!response.ok) {
      return errorResult(config, started, `HTTP ${response.status} ${response.statusText}`.trim());
    }

    const payload = await readJson(response);
    return {
      hookId: config.id,
      hookName: config.name,
      type: config.type,
      blocking: Boolean(payload?.blocking),
      durationMs: Date.now() - started,
      message: typeof payload?.message === "string" ? payload.message : undefined,
      metadata: isRecord(payload?.metadata) ? payload.metadata : undefined,
    };
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError"
      ? `hook timed out after ${config.timeoutMs ?? 0}ms`
      : normalizeError(err);
    return errorResult(config, started, message);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function validateHookUrl(url: string, allowedHosts: string[] = []): { ok: true } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "invalid hook url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "hook url must use http or https" };
  }
  const host = parsed.hostname;
  const normalizedAllowed = new Set(allowedHosts.map((value) => value.replace(/^\[|\]$/g, "")));
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(normalizedHost) || normalizedAllowed.has(normalizedHost)) {
    return { ok: true };
  }
  return { ok: false, error: `external hook host not allowed: ${host}` };
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorResult(config: HttpHookConfig & { id: string }, started: number, error: string): HookResult {
  return {
    hookId: config.id,
    hookName: config.name,
    type: config.type,
    blocking: false,
    durationMs: Date.now() - started,
    error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
