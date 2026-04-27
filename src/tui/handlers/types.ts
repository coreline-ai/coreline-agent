/**
 * Wave 10 P0 / F1 — Shared handler context types for REPL slash-command
 * action handlers. Each handler receives a typed action `data` payload and
 * a `HandlerContext` with project memory + projectId + (optional) rootDir.
 */

import type { ProjectMemoryCore } from "../../memory/types.js";

export interface HandlerContext {
  /** Live project memory (used by fact / decay / link / search-precise). */
  projectMemory: ProjectMemoryCore;
  /** Project id (used by incident / decision / runbook / rca / evidence-first). */
  projectId: string;
  /**
   * Optional rootDir override. Production callers should leave this undefined
   * (paths.ts derives the global rootDir). Tests pass an isolated tmp dir.
   */
  rootDir?: string;
}
