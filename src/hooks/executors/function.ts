import type { FunctionHookConfig, HookInput, HookResult } from "../types.js";

export async function executeFunctionHook(
  config: FunctionHookConfig & { id: string },
  input: HookInput,
  signal?: AbortSignal,
): Promise<HookResult> {
  const started = Date.now();
  try {
    const result = await withTimeout(
      Promise.resolve(config.handler(input, { signal })),
      config.timeoutMs,
      signal,
    );
    return {
      hookId: config.id,
      hookName: config.name,
      type: config.type,
      blocking: Boolean(result?.blocking),
      durationMs: Date.now() - started,
      message: result?.message,
      metadata: result?.metadata,
    };
  } catch (err) {
    return {
      hookId: config.id,
      hookName: config.name,
      type: config.type,
      blocking: false,
      durationMs: Date.now() - started,
      error: normalizeError(err),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  if (!timeoutMs && !signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("hook aborted")));

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => finish(() => reject(new Error(`hook timed out after ${timeoutMs}ms`))), timeoutMs);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    promise.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
