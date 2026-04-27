export type LifecycleDestroyReason = "SIGINT" | "SIGTERM" | "uncaughtException" | "beforeExit" | "manual";

export interface LifecycleSessionContext {
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface LifecycleSessionStartContext extends LifecycleSessionContext {
  startedAt: string;
}

export interface LifecycleSessionEndContext extends LifecycleSessionContext {
  endedAt: string;
  reason: LifecycleDestroyReason;
  error?: unknown;
}

export type LifecycleCleanup = () => void | Promise<void>;
export type LifecycleSessionStartListener = (context: LifecycleSessionStartContext) => void | Promise<void>;
export type LifecycleSessionEndListener = (context: LifecycleSessionEndContext) => void | Promise<void>;

export interface LifecycleCleanupResult {
  id: number;
  label?: string;
  status: "fulfilled" | "rejected";
  error?: unknown;
}

export interface LifecycleDestroyResult {
  reason: LifecycleDestroyReason;
  cleanupResults: LifecycleCleanupResult[];
  sessionStarted: boolean;
  sessionEnded: boolean;
}

export interface LifecycleController {
  addCleanup(cleanup: LifecycleCleanup, label?: string): () => void;
  onSessionStart(listener: LifecycleSessionStartListener): () => void;
  onSessionEnd(listener: LifecycleSessionEndListener): () => void;
  beginSession(context?: LifecycleSessionContext): Promise<void>;
  destroy(reason: LifecycleDestroyReason, error?: unknown): Promise<LifecycleDestroyResult>;
  readonly destroying: boolean;
  readonly destroyed: boolean;
}

interface CleanupEntry {
  id: number;
  label?: string;
  cleanup: LifecycleCleanup;
  executed: boolean;
  removed: boolean;
}

interface LifecycleOptions {
  onSessionStart?: LifecycleSessionStartListener;
  onSessionEnd?: LifecycleSessionEndListener;
}

export function createLifecycle(options: LifecycleOptions = {}): LifecycleController {
  const cleanups: CleanupEntry[] = [];
  const sessionStartListeners = new Set<LifecycleSessionStartListener>();
  const sessionEndListeners = new Set<LifecycleSessionEndListener>();

  if (options.onSessionStart) {
    sessionStartListeners.add(options.onSessionStart);
  }
  if (options.onSessionEnd) {
    sessionEndListeners.add(options.onSessionEnd);
  }

  let nextCleanupId = 1;
  let destroying = false;
  let destroyed = false;
  let destroyPromise: Promise<LifecycleDestroyResult> | null = null;
  let sessionStarted = false;
  let sessionEnded = false;
  let sessionStartContext: LifecycleSessionStartContext | null = null;

  const emitSessionStart = async (context: LifecycleSessionStartContext): Promise<void> => {
    for (const listener of sessionStartListeners) {
      try {
        await listener(context);
      } catch {
        // Best-effort dispatch: session start errors must not break startup.
      }
    }
  };

  const emitSessionEnd = async (context: LifecycleSessionEndContext): Promise<void> => {
    for (const listener of sessionEndListeners) {
      try {
        await listener(context);
      } catch {
        // Best-effort dispatch: session end errors must not block cleanup completion.
      }
    }
  };

  const runCleanup = async (entry: CleanupEntry): Promise<LifecycleCleanupResult> => {
    if (entry.removed || entry.executed) {
      return {
        id: entry.id,
        label: entry.label,
        status: "fulfilled",
      };
    }

    entry.executed = true;
    try {
      await entry.cleanup();
      return {
        id: entry.id,
        label: entry.label,
        status: "fulfilled",
      };
    } catch (error) {
      return {
        id: entry.id,
        label: entry.label,
        status: "rejected",
        error,
      };
    }
  };

  const runLateCleanup = (entry: CleanupEntry): void => {
    void runCleanup(entry);
  };

  return {
    addCleanup(cleanup: LifecycleCleanup, label?: string): () => void {
      const entry: CleanupEntry = {
        id: nextCleanupId++,
        label,
        cleanup,
        executed: false,
        removed: false,
      };

      if (destroyed || destroying) {
        runLateCleanup(entry);
        return () => {
          entry.removed = true;
        };
      }

      cleanups.push(entry);
      return () => {
        entry.removed = true;
      };
    },

    onSessionStart(listener: LifecycleSessionStartListener): () => void {
      sessionStartListeners.add(listener);
      return () => {
        sessionStartListeners.delete(listener);
      };
    },

    onSessionEnd(listener: LifecycleSessionEndListener): () => void {
      sessionEndListeners.add(listener);
      return () => {
        sessionEndListeners.delete(listener);
      };
    },

    async beginSession(context: LifecycleSessionContext = {}): Promise<void> {
      if (destroyed || destroying || sessionStarted) {
        return;
      }

      sessionStarted = true;
      sessionStartContext = {
        sessionId: context.sessionId,
        metadata: context.metadata,
        startedAt: new Date().toISOString(),
      };
      await emitSessionStart(sessionStartContext);
    },

    async destroy(reason: LifecycleDestroyReason, error?: unknown): Promise<LifecycleDestroyResult> {
      if (destroyPromise) {
        return destroyPromise;
      }

      destroyPromise = (async () => {
        destroying = true;
        const cleanupResults: LifecycleCleanupResult[] = [];

        for (const entry of [...cleanups].reverse()) {
          if (entry.removed || entry.executed) {
            continue;
          }
          cleanupResults.push(await runCleanup(entry));
        }

        if (sessionStarted && !sessionEnded) {
          sessionEnded = true;
          await emitSessionEnd({
            sessionId: sessionStartContext?.sessionId,
            metadata: sessionStartContext?.metadata,
            endedAt: new Date().toISOString(),
            reason,
            error,
          });
        }

        destroyed = true;
        destroying = false;
        return {
          reason,
          cleanupResults,
          sessionStarted,
          sessionEnded,
        };
      })().finally(() => {
        destroying = false;
      });

      return destroyPromise;
    },

    get destroying() {
      return destroying;
    },

    get destroyed() {
      return destroyed;
    },
  };
}

export const createRuntimeCleanupStack = createLifecycle;
