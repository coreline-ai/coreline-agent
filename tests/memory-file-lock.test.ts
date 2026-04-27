/**
 * Wave 10 R1 — File lock primitive (mkdir-atomicity).
 *
 * Covers: acquire/release roundtrip, concurrent acquisition serialization,
 * timeout, stale lock removal, sync variant, release-on-error, lock path.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireFileLock,
  acquireFileLockSync,
  lockPathFor,
} from "../src/memory/file-lock.js";

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-flock-"));
}

describe("Wave 10 R1 — file-lock", () => {
  test("R1.1: acquire + release roundtrip", async () => {
    const root = mkRoot();
    try {
      const target = join(root, "foo.json");
      const lock = await acquireFileLock(target);
      expect(existsSync(`${target}.lock`)).toBe(true);
      lock.release();
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R1.2: concurrent acquire — Promise.all 5x serialize correctly", async () => {
    const root = mkRoot();
    try {
      const target = join(root, "shared.json");
      const order: number[] = [];
      const tasks = Array.from({ length: 5 }, (_, i) => async () => {
        const lock = await acquireFileLock(target, { timeoutMs: 10_000, pollMs: 5 });
        try {
          order.push(i);
          // Hold lock for a brief moment to force serialization
          await new Promise((r) => setTimeout(r, 10));
          // Verify exclusive: lock dir exists during the critical section
          expect(existsSync(`${target}.lock`)).toBe(true);
        } finally {
          lock.release();
        }
      });
      await Promise.all(tasks.map((t) => t()));
      expect(order.length).toBe(5);
      // After all releases, lock dir is gone
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R1.3: timeout error when contention exceeds timeoutMs", async () => {
    const root = mkRoot();
    try {
      const target = join(root, "blocked.json");
      // Pre-hold the lock with a fresh recent mtime by manually creating it
      mkdirSync(`${target}.lock`);
      try {
        await expect(
          acquireFileLock(target, { timeoutMs: 100, pollMs: 20 }),
        ).rejects.toThrow(/File lock timeout/);
      } finally {
        rmSync(`${target}.lock`, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R1.4: stale lock detection — old lock force-removed", async () => {
    const root = mkRoot();
    try {
      const target = join(root, "stale.json");
      mkdirSync(`${target}.lock`);
      // Backdate mtime: 60s in the past, way beyond 5x of timeoutMs=100ms.
      const oldTime = new Date(Date.now() - 60_000);
      // utimesSync via node:fs
      const { utimesSync } = await import("node:fs");
      utimesSync(`${target}.lock`, oldTime, oldTime);

      // With timeoutMs=100, stale threshold is 500ms — our 60s lock is stale.
      // Even though we hit the timeout first, the post-timeout stale-removal
      // path should kick in and acquire successfully.
      const lock = await acquireFileLock(target, { timeoutMs: 100, pollMs: 20 });
      try {
        expect(existsSync(`${target}.lock`)).toBe(true);
      } finally {
        lock.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R1.5: sync variant works", () => {
    const root = mkRoot();
    try {
      const target = join(root, "sync.json");
      const lock = acquireFileLockSync(target);
      try {
        expect(existsSync(`${target}.lock`)).toBe(true);
      } finally {
        lock.release();
      }
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R1.6: release on uncaught error — try/finally pattern", async () => {
    const root = mkRoot();
    try {
      const target = join(root, "err.json");
      const lock = await acquireFileLock(target);
      let caught: unknown = null;
      try {
        try {
          throw new Error("boom");
        } finally {
          lock.release();
        }
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toBe("boom");
      expect(existsSync(`${target}.lock`)).toBe(false);
      // Acquire again succeeds
      const lock2 = await acquireFileLock(target);
      lock2.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R1.7: lockPathFor format = `${target}.lock`", () => {
    expect(lockPathFor("/a/b/c.json")).toBe("/a/b/c.json.lock");
    expect(lockPathFor("foo.json")).toBe("foo.json.lock");
  });

  test("R1.8: idempotent release", async () => {
    const root = mkRoot();
    try {
      const target = join(root, "idem.json");
      const lock = await acquireFileLock(target);
      lock.release();
      lock.release(); // no-op
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
