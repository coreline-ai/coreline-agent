/**
 * Memory health handler — renders /memory health output for TUI.
 */

import type { HandlerContext } from "./types.js";
import { computeMemoryHealth, formatMemoryHealthMarkdown } from "../../memory/health.js";

export async function handleMemoryHealthCommand(
  _data: unknown,
  context: HandlerContext,
): Promise<string> {
  try {
    const report = computeMemoryHealth(context.projectMemory, context.rootDir);
    return formatMemoryHealthMarkdown(report);
  } catch (err) {
    return `Error computing memory health: ${(err as Error).message}`;
  }
}
