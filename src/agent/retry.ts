/**
 * Retry logic — exponential backoff for API calls.
 */

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Error types to retry (e.g. network, rate limit) */
  retryable?: (error: Error) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  retryable: isRetryableError,
};

function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // Network errors
  if (msg.includes("fetch failed") || msg.includes("econnrefused") || msg.includes("econnreset")) return true;
  if (msg.includes("network") || msg.includes("timeout") || msg.includes("etimedout")) return true;
  // Rate limit (429)
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return true;
  // Server errors (500, 502, 503)
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("overloaded")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic.
 * Returns the result on success, throws after all retries exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      if (attempt >= opts.maxRetries) break;
      if (!opts.retryable!(lastError)) break;

      const delay = Math.min(
        opts.initialDelayMs * Math.pow(2, attempt) + Math.random() * 500,
        opts.maxDelayMs,
      );
      console.error(`[retry] Attempt ${attempt + 1}/${opts.maxRetries} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }

  throw lastError!;
}
