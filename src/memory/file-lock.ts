/**
 * Cross-process file lock (Wave 10 R1) — POSIX `mkdir` atomicity.
 *
 * Acquires an exclusive lock for `targetPath` by atomically creating a sibling
 * `<targetPath>.lock` directory. Multiple concurrent `mkdirSync(..., { recursive:
 * false })` calls compete; exactly one succeeds, others receive `EEXIST` and
 * retry. Stale locks older than `5 * timeoutMs` are force-removed with a warning.
 *
 * Zero new dependencies — relies only on `node:fs`.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";

export interface FileLock {
  /** Release the lock. Idempotent — safe to call multiple times. */
  release(): void;
}

export interface AcquireOptions {
  /** Total timeout in ms before giving up. Default 5000. */
  timeoutMs?: number;
  /** Polling interval. Default 50ms. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 50;
const STALE_MULTIPLIER = 5;

/** Compute the lock directory path for a target file. */
export function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`;
}

function tryRemoveStaleLock(lockPath: string, timeoutMs: number): boolean {
  try {
    const st = statSync(lockPath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > timeoutMs * STALE_MULTIPLIER) {
      // best-effort: force-remove. If another process just acquired it under us,
      // they will rebuild during their try. Worst case: we briefly invalidate
      // someone else's lock; acceptable trade vs. permanent deadlock.
      // eslint-disable-next-line no-console
      console.warn(
        `[file-lock] Removing stale lock ${lockPath} (age=${Math.round(ageMs)}ms > ${timeoutMs * STALE_MULTIPLIER}ms)`,
      );
      rmSync(lockPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    /* swallow — stat failed, will retry */
  }
  return false;
}

function tryAcquire(lockPath: string): boolean {
  try {
    mkdirSync(lockPath, { recursive: false });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

function makeRelease(lockPath: string): FileLock {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* swallow — best effort */
      }
    },
  };
}

/**
 * Acquire an exclusive lock for a file via sibling `.lock` directory creation.
 * Returns a release handle. Throws if `timeoutMs` exceeded.
 *
 * Usage:
 * ```
 * const lock = await acquireFileLock("/path/to/forward.json");
 * try {
 *   // ... atomic write
 * } finally {
 *   lock.release();
 * }
 * ```
 */
export async function acquireFileLock(
  targetPath: string,
  options: AcquireOptions = {},
): Promise<FileLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const lockPath = lockPathFor(targetPath);
  const start = Date.now();

  while (true) {
    if (tryAcquire(lockPath)) {
      return makeRelease(lockPath);
    }
    if (Date.now() - start >= timeoutMs) {
      // Last-ditch: try stale removal before throwing
      if (tryRemoveStaleLock(lockPath, timeoutMs) && tryAcquire(lockPath)) {
        return makeRelease(lockPath);
      }
      throw new Error(`File lock timeout: ${targetPath}`);
    }
    // periodic stale check (every ~10 polls)
    if ((Date.now() - start) % (pollMs * 10) < pollMs) {
      tryRemoveStaleLock(lockPath, timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Synchronous variant — uses busy-wait sleep (Atomics.wait on a small
 * SharedArrayBuffer). Prefer `acquireFileLock` when an `await` is available.
 */
export function acquireFileLockSync(
  targetPath: string,
  options: AcquireOptions = {},
): FileLock {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const lockPath = lockPathFor(targetPath);
  const start = Date.now();
  // tiny SAB so Atomics.wait blocks the thread without burning CPU
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);

  let pollCount = 0;
  while (true) {
    if (tryAcquire(lockPath)) {
      return makeRelease(lockPath);
    }
    if (Date.now() - start >= timeoutMs) {
      if (tryRemoveStaleLock(lockPath, timeoutMs) && tryAcquire(lockPath)) {
        return makeRelease(lockPath);
      }
      throw new Error(`File lock timeout: ${targetPath}`);
    }
    pollCount++;
    if (pollCount % 10 === 0) {
      tryRemoveStaleLock(lockPath, timeoutMs);
    }
    // Block the thread for `pollMs` without busy CPU spin.
    Atomics.wait(i32, 0, 0, pollMs);
  }
}
