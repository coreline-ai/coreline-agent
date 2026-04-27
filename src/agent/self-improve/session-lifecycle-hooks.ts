/**
 * Session-level lifecycle hooks (I1 fix).
 *
 * Previously, `evaluateSessionSkills`, `indexSession`, and
 * `sessionTickAndMaybePromote` fired on every turn-end in `loop.ts`. In
 * interactive TUI/autopilot sessions where one user sits through N turns,
 * this produced per-turn evidence/index/promotion rather than the intended
 * per-session semantics.
 *
 * This module collects state via `trackSessionTurn()` (called from loop.ts
 * turn-end) and flushes via `finalizeSession()` (called from
 * `runtimeLifecycle.onSessionEnd()` in index.ts). Result: hooks fire once
 * per actual session end, not once per turn.
 */

import type { ChatMessage } from "../types.js";
import type { ProjectMemoryCore } from "../../memory/types.js";
import { evaluateSessionSkills } from "./skill-tracker.js";
import { indexSession } from "../../memory/session-recall.js";
import { sessionTickAndMaybePromote } from "../../memory/auto-promote.js";
import { resetToolFailureCounters } from "../incident/incident-escalation.js";
import { SessionStateLRU } from "./session-state-lru.js";

interface SessionState {
  projectId: string;
  projectMemory: ProjectMemoryCore;
  latestMessages: ChatMessage[];
  turnCount: number;
  /** Optional rootDir override for test isolation (from tests). */
  rootDir?: string;
}

const sessions = new SessionStateLRU<SessionState>(100);

/**
 * Called at the end of each completed turn. Updates the session's latest
 * message snapshot but does NOT write evidence yet. Flush happens at
 * `finalizeSession(sessionId)` (from `onSessionEnd`).
 */
export function trackSessionTurn(params: {
  sessionId: string | undefined;
  projectMemory: ProjectMemoryCore | undefined;
  messages: ChatMessage[];
  /** Optional rootDir override — used by tests for isolation. Undefined = production default. */
  rootDir?: string;
}): void {
  const { sessionId, projectMemory, messages, rootDir } = params;
  if (!sessionId || !projectMemory?.projectId) return;

  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    projectId: projectMemory.projectId,
    projectMemory,
    latestMessages: messages,
    turnCount: (existing?.turnCount ?? 0) + 1,
    rootDir: rootDir ?? existing?.rootDir,
  });
}

/**
 * Flush all pending session-end work for a single session.
 * Called when a specific sessionId's lifecycle ends.
 * Best-effort: swallows all errors.
 */
export function finalizeSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  sessions.delete(sessionId);

  try {
    evaluateSessionSkills({
      projectId: state.projectId,
      sessionId,
      turnReason: "completed",
      turnsUsed: state.latestMessages.length,
      rootDir: state.rootDir,
    });
  } catch {
    // best-effort
  }

  try {
    indexSession({
      projectId: state.projectId,
      sessionId,
      messages: state.latestMessages,
      rootDir: state.rootDir,
    });
  } catch {
    // best-effort
  }

  try {
    sessionTickAndMaybePromote(state.projectMemory, { everyN: 1 });
  } catch {
    // best-effort
  }

  try {
    resetToolFailureCounters(sessionId);
  } catch {
    // best-effort
  }
}

/**
 * Flush ALL pending sessions. Called from `runtimeLifecycle.onSessionEnd()`
 * so that on process termination (manual/beforeExit/SIGINT/SIGTERM), any
 * sessions still tracked get their evidence recorded.
 */
export function finalizeAllSessions(): void {
  const ids = Array.from(sessions.keys());
  for (const id of ids) finalizeSession(id);
}

/** Count of currently tracked sessions (for testing). */
export function trackedSessionCount(): number {
  return sessions.size();
}

/** Clear all tracked state (for testing). */
export function resetSessionTracker(): void {
  sessions.clear();
}
