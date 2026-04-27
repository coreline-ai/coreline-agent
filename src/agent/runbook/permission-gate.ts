/**
 * Runbook permission gate (Wave 10 P2 — F5).
 *
 * Decides whether a bash step extracted from a runbook may be executed
 * inside the sandboxed runner. Reuses coreline-agent's existing Bash
 * classifier so the same dangerous-pattern coverage applies, and falls
 * back to an explicit MVP block list for fork bombs / `sudo rm` / piped
 * curl-to-shell that the classifier already considers `ask` but which the
 * sandbox must hard-deny because there is no interactive prompt.
 *
 * Returns:
 *   { allowed: true } when the step is safe to run unattended.
 *   { allowed: false, reason } when denied or requires confirmation.
 */

import { classifyBashCommand } from "../../permissions/classifier.js";

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Hard block list for sandbox execution. These patterns MUST NEVER reach a
 * spawned shell, even if a custom permission rule would otherwise allow
 * them.
 */
const SANDBOX_BLOCKLIST: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf?\s+\/(\s|$)/, reason: "rm -rf / blocked" },
  { pattern: /rm\s+-rf?\s+\.(\s|$)/, reason: "rm -rf . blocked" },
  { pattern: /rm\s+-rf?\s+\*/, reason: "rm -rf * blocked" },
  { pattern: /:\s*\(\s*\)\s*\{/, reason: "fork bomb pattern blocked" },
  { pattern: /\bdd\s+if=/, reason: "dd if= blocked" },
  { pattern: /\bmkfs\b/, reason: "mkfs blocked" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "raw block device write blocked" },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: "chmod -R 777 / blocked" },
  { pattern: /\bsudo\b/, reason: "sudo blocked in sandbox" },
  { pattern: /\bsu\s+-/, reason: "su - blocked in sandbox" },
  { pattern: /mv\s+\/[^\s]*\s+/, reason: "mv from root path blocked" },
  {
    pattern: /\bcurl\b[^|;&]*\|\s*(sh|bash|zsh)\b/,
    reason: "curl piped to shell blocked",
  },
  {
    pattern: /\bwget\b[^|;&]*\|\s*(sh|bash|zsh)\b/,
    reason: "wget piped to shell blocked",
  },
  {
    pattern: /\beval\b/,
    reason: "eval blocked in sandbox",
  },
  { pattern: /\bshutdown\b/, reason: "shutdown blocked" },
  { pattern: /\breboot\b/, reason: "reboot blocked" },
  { pattern: /\bhalt\b/, reason: "halt blocked" },
];

/**
 * Check whether a bash command is allowed under the runbook sandbox gate.
 *
 * Order:
 *   1. Empty / whitespace-only steps → denied.
 *   2. Hard block list → denied with the specific reason.
 *   3. Existing Bash classifier:
 *        - `allow` → allowed
 *        - `deny`  → denied
 *        - `ask`   → denied (sandbox is non-interactive)
 */
export function checkRunbookStepPermission(command: string): GateResult {
  const trimmed = (command ?? "").trim();
  if (!trimmed) {
    return { allowed: false, reason: "empty_command" };
  }

  for (const entry of SANDBOX_BLOCKLIST) {
    if (entry.pattern.test(trimmed)) {
      return { allowed: false, reason: entry.reason };
    }
  }

  const result = classifyBashCommand(trimmed);
  if (result.behavior === "allow") {
    return { allowed: true };
  }

  if (result.behavior === "deny") {
    return { allowed: false, reason: result.reason ?? "denied" };
  }

  // ask → sandbox cannot prompt
  return {
    allowed: false,
    reason: `ask_required: ${result.reason ?? "user confirmation required"}`,
  };
}
