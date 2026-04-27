import { createHookEngine, type HookEngine } from "./index.js";
import type { AgentStatusSnapshot } from "../agent/status.js";
import type { HookResult, StatusChangeHookInput } from "./types.js";

export interface CorelineHookRuntime {
  engine: HookEngine;
  dispatchStatusChange(snapshot: AgentStatusSnapshot, previous?: AgentStatusSnapshot): Promise<HookResult[]>;
}

export function createCorelineHookRuntime(engine: HookEngine = createHookEngine()): CorelineHookRuntime {
  return {
    engine,
    dispatchStatusChange(snapshot, previous) {
      return dispatchStatusChange(engine, snapshot, previous);
    },
  };
}

export async function dispatchStatusChange(
  engine: HookEngine,
  snapshot: AgentStatusSnapshot,
  previous?: AgentStatusSnapshot,
): Promise<HookResult[]> {
  const input: StatusChangeHookInput = {
    event: "StatusChange",
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    previousStatus: previous?.status,
    snapshot,
    metadata: {
      mode: snapshot.mode,
      provider: snapshot.provider,
      model: snapshot.model,
      turn: snapshot.turn,
      message: snapshot.message,
    },
  };
  return engine.execute("StatusChange", input);
}
