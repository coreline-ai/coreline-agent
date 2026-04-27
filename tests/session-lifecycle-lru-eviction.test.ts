/**
 * Wave 10 P1 R5 — verify session-lifecycle-hooks bounds its session Map
 * via the SessionStateLRU wrapper (cap 100, insertion-order eviction).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  trackSessionTurn,
  finalizeSession,
  trackedSessionCount,
  resetSessionTracker,
} from "../src/agent/self-improve/session-lifecycle-hooks.js";
import { resetRegistry } from "../src/agent/self-improve/applied-skill-registry.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import type { ChatMessage } from "../src/agent/types.js";

function mkMessage(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: text } as any;
}

describe("session-lifecycle-hooks LRU eviction (Wave 10 P1 R5)", () => {
  beforeEach(() => {
    resetRegistry();
    resetSessionTracker();
  });

  test("100 sessions tracked → size 100 (at cap)", () => {
    const root = mkdtempSync(join(tmpdir(), "lru-cap-"));
    try {
      const mem = new ProjectMemory("/tmp/lru-cap-100", { rootDir: root });
      for (let i = 0; i < 100; i++) {
        trackSessionTurn({
          sessionId: `sess-${i}`,
          projectMemory: mem,
          messages: [mkMessage("user", `turn ${i}`)],
          rootDir: root,
        });
      }
      expect(trackedSessionCount()).toBe(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("101st session evicts oldest, size stays at 100", () => {
    const root = mkdtempSync(join(tmpdir(), "lru-cap-"));
    try {
      const mem = new ProjectMemory("/tmp/lru-cap-101", { rootDir: root });
      for (let i = 0; i < 100; i++) {
        trackSessionTurn({
          sessionId: `sess-${i}`,
          projectMemory: mem,
          messages: [mkMessage("user", `turn ${i}`)],
          rootDir: root,
        });
      }
      expect(trackedSessionCount()).toBe(100);

      // Add the 101st session — should evict the oldest (sess-0).
      trackSessionTurn({
        sessionId: "sess-100",
        projectMemory: mem,
        messages: [mkMessage("user", "turn 100")],
        rootDir: root,
      });

      expect(trackedSessionCount()).toBe(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finalizeSession on evicted sessionId is a safe no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "lru-cap-"));
    try {
      const mem = new ProjectMemory("/tmp/lru-cap-evicted", { rootDir: root });
      for (let i = 0; i < 100; i++) {
        trackSessionTurn({
          sessionId: `sess-${i}`,
          projectMemory: mem,
          messages: [mkMessage("user", `turn ${i}`)],
          rootDir: root,
        });
      }
      // Push past cap — sess-0 should be evicted.
      trackSessionTurn({
        sessionId: "sess-100",
        projectMemory: mem,
        messages: [mkMessage("user", "turn 100")],
        rootDir: root,
      });

      // Finalizing the evicted sessionId must not throw.
      expect(() => finalizeSession("sess-0")).not.toThrow();
      // Size unchanged because evicted session was already gone.
      expect(trackedSessionCount()).toBe(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
