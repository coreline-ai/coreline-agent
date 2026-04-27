/**
 * Statusline command safety helpers.
 *
 * These helpers intentionally never execute commands. They only validate and
 * return a preview so callers can surface statusline intent without crossing a
 * shell-execution boundary.
 */

import type { AgentStatuslinePreview } from "./status.js";
import { classifyBashCommand } from "../permissions/classifier.js";

export type StatuslineCommandRisk = "safe" | "needs_confirmation" | "blocked" | "invalid";

export interface StatuslineCommandValidation extends AgentStatuslinePreview {
  risk: StatuslineCommandRisk;
  permissionBehavior?: "allow" | "ask" | "deny";
}

const MAX_STATUSLINE_COMMAND_LENGTH = 500;

export function validateStatuslineCommand(command: string): StatuslineCommandValidation {
  const preview = command.trim();

  if (!preview) {
    return {
      valid: false,
      wouldExecute: false,
      risk: "invalid",
      reason: "Statusline command is empty.",
    };
  }

  if (preview.length > MAX_STATUSLINE_COMMAND_LENGTH) {
    return {
      valid: false,
      wouldExecute: false,
      risk: "invalid",
      command: preview.slice(0, MAX_STATUSLINE_COMMAND_LENGTH),
      preview: preview.slice(0, MAX_STATUSLINE_COMMAND_LENGTH),
      reason: `Statusline command is too long (${preview.length}/${MAX_STATUSLINE_COMMAND_LENGTH}).`,
    };
  }

  const permission = classifyBashCommand(preview);
  const risk: StatuslineCommandRisk =
    permission.behavior === "allow"
      ? "safe"
      : permission.behavior === "ask"
        ? "needs_confirmation"
        : "blocked";

  return {
    valid: permission.behavior !== "deny",
    wouldExecute: false,
    risk,
    permissionBehavior: permission.behavior,
    command: preview,
    preview,
    reason: permission.reason,
  };
}
