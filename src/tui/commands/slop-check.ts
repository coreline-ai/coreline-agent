/**
 * Slop-check slash sub-router — handles /slop-check <path>.
 * Concept inspired by huashu-design content guidelines (independent implementation).
 */

import type { SlashCommandResult } from "../slash-commands.js";

export function handleSlopCheck(
  cmd: string,
  args: string[],
): SlashCommandResult | null {
  if (cmd !== "slop-check" && cmd !== "slopcheck") return null;
  const path = args[0];
  if (!path) {
    return { handled: true, output: "Usage: /slop-check <file-path>" };
  }
  return { handled: true, action: "slop_check", data: { path } };
}
