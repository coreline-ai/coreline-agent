/**
 * Lifecycle listener that generates MEMORY.md on session end.
 *
 * Factory only — registration is wired by src/index.ts during final integration.
 */

import type { ProjectMemoryCore } from "../memory/types.js";
import { renderDigest, writeDigest } from "../memory/digest.js";

export interface CreateDigestListenerParams {
  projectMemory: ProjectMemoryCore;
  rootDir?: string;
}

/**
 * Returns a listener that — on normal termination (manual|beforeExit) —
 * renders the MEMORY.md digest and best-effort writes it to the project dir.
 * Never throws.
 */
export function createDigestListener(
  params: CreateDigestListenerParams,
): (event: { reason: string }) => void {
  const { projectMemory, rootDir } = params;

  return (event: { reason: string }): void => {
    try {
      if (event.reason !== "manual" && event.reason !== "beforeExit") {
        return;
      }
      const result = renderDigest({ projectMemory });
      writeDigest({
        projectId: projectMemory.projectId,
        content: result.content,
        rootDir,
      });
    } catch {
      // Best-effort: swallow all errors — digest must never break shutdown.
    }
  };
}
