/**
 * Permission system types.
 *
 * Simplified from Claude Code's PermissionResult/PermissionRule pattern.
 * Three modes: default (ask for dangerous), acceptAll, denyAll.
 */

// ---------------------------------------------------------------------------
// Permission Mode
// ---------------------------------------------------------------------------

export type PermissionMode = "default" | "acceptAll" | "denyAll";

// ---------------------------------------------------------------------------
// Permission Rule (loaded from permissions.yml)
// ---------------------------------------------------------------------------

export interface PermissionRule {
  /** allow = auto-approve, deny = auto-reject, ask = prompt user */
  behavior: "allow" | "deny" | "ask";

  /** Tool name to match (e.g. "Bash", "FileWrite", "*" for all) */
  toolName: string;

  /** Optional pattern to match against tool input (e.g. "npm test" for Bash) */
  pattern?: string;
}

// ---------------------------------------------------------------------------
// Permission Result
// ---------------------------------------------------------------------------

export interface PermissionResult {
  behavior: "allow" | "deny" | "ask";
  reason?: string;
  matchedRule?: PermissionRule;
}

// ---------------------------------------------------------------------------
// Permission Check Context
// ---------------------------------------------------------------------------

export interface PermissionCheckContext {
  /** Current working directory */
  cwd: string;

  /** Current permission mode */
  mode: PermissionMode;

  /** User-defined rules */
  rules: PermissionRule[];
}
