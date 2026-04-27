/**
 * Permission Engine — rule-based permission checking for tool calls.
 *
 * Priority: deny > ask > allow (deny always wins).
 * Falls back to classifier-based decisions for Bash commands.
 */

import type { PermissionCheckContext, PermissionResult, PermissionRule } from "./types.js";
import { classifyBashCommand } from "./classifier.js";
import { classifyMcpToolPermission } from "../mcp/policy.js";
import { matchesPermissionRule } from "./matcher.js";
import {
  checkFilesystemPathHardening,
  checkFilesystemWritePathHardening,
  collectExistingPathRealpaths,
} from "./filesystem-hardening.js";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// System-level deny patterns (always denied regardless of rules)
// ---------------------------------------------------------------------------

const SYSTEM_DENY_PATHS = [
  "/etc/passwd", "/etc/shadow", "/etc/sudoers",
  "/etc/ssl",
  "/proc", "/sys",
  "/root",
  "/boot",
];

/** /dev paths that ARE safe to use (redirect targets, etc.) */
const SAFE_DEV_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);
const WRITE_TOOL_NAMES = new Set(["FileWrite", "FileEdit", "MemoryWrite"]);
const FILESYSTEM_PATH_WRITE_TOOL_NAMES = new Set(["FileWrite", "FileEdit"]);
const READ_ONLY_TOOL_NAMES = new Set([
  "FileRead",
  "Glob",
  "Grep",
  "MemoryRead",
  "AskUserQuestion",
  "ListMcpResources",
  "ReadMcpResource",
]);
const INTERNAL_STATE_TOOL_NAMES = new Set(["TodoWrite"]);

function isSystemPath(path: string): boolean {
  // /dev/* is denied except safe targets
  if (path.startsWith("/dev/") || path === "/dev") {
    return !SAFE_DEV_PATHS.has(path);
  }
  return SYSTEM_DENY_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

function getProtectedSystemPath(path: string, cwd: string): string | undefined {
  if (SAFE_DEV_PATHS.has(path.replace(/\/+$/u, ""))) {
    return undefined;
  }

  const candidates = [
    path,
    resolve(cwd, path),
    ...collectExistingPathRealpaths(path, cwd),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isSystemPath(candidate)) return candidate;
  }

  return undefined;
}

function getStringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function getPrimaryPathInput(input: Record<string, unknown>): string | undefined {
  return getStringInput(input, "file_path") ?? getStringInput(input, "path");
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getDelegatedWriteTools(input: Record<string, unknown>): string[] {
  const allowedTools = getStringArray(input.allowedTools);
  return allowedTools.filter((tool) => WRITE_TOOL_NAMES.has(tool));
}

function formatDelegatedWriteReason(writeTools: string[]): string {
  const tools = writeTools.join(", ");
  return [
    `Delegated child requested write-capable tools: ${tools}.`,
    "Confirm before spawning this child.",
    "Non-interactive child runs will deny write requests automatically.",
  ].join(" ");
}

interface WriteHardeningInput {
  path: string;
  followRealpaths: boolean;
}

function getWriteHardeningInputs(toolName: string, input: Record<string, unknown>): WriteHardeningInput[] {
  if (!WRITE_TOOL_NAMES.has(toolName)) return [];

  const candidates: WriteHardeningInput[] = [];

  if (FILESYSTEM_PATH_WRITE_TOOL_NAMES.has(toolName)) {
    const filePath = getStringInput(input, "file_path");
    const path = getStringInput(input, "path");
    if (filePath) candidates.push({ path: filePath, followRealpaths: true });
    if (path) candidates.push({ path, followRealpaths: true });
  }

  // MemoryWrite names are not arbitrary user filesystem paths, but the memory
  // store is filesystem-backed. Apply raw segment/device hardening without
  // resolving against cwd, which avoids overblocking safe memory names just
  // because the current directory itself is a symlink.
  if (toolName === "MemoryWrite") {
    const name = getStringInput(input, "name");
    if (name) candidates.push({ path: name, followRealpaths: false });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.path.length === 0) return false;
    const key = `${candidate.followRealpaths ? "real" : "raw"}:${candidate.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Permission Engine
// ---------------------------------------------------------------------------

export class PermissionEngine {
  check(
    toolName: string,
    input: Record<string, unknown>,
    context: PermissionCheckContext,
  ): PermissionResult {
    // Mode-based shortcuts
    if (context.mode === "acceptAll") {
      return { behavior: "allow", reason: "acceptAll mode" };
    }
    if (context.mode === "denyAll") {
      return { behavior: "deny", reason: "denyAll mode" };
    }

    // System-level deny (path-based)
    const filePath = getPrimaryPathInput(input);
    const protectedSystemPath = filePath ? getProtectedSystemPath(filePath, context.cwd) : undefined;
    if (protectedSystemPath) {
      return {
        behavior: "deny",
        reason: `System path protected: ${protectedSystemPath}`,
      };
    }

    for (const hardeningInput of getWriteHardeningInputs(toolName, input)) {
      const hardening = hardeningInput.followRealpaths
        ? checkFilesystemWritePathHardening(hardeningInput.path, context.cwd)
        : checkFilesystemPathHardening(hardeningInput.path);
      if (!hardening.allowed && hardening.violation) {
        return {
          behavior: "deny",
          reason: `Filesystem hardening denied ${hardeningInput.path}: ${hardening.violation.reason}`,
        };
      }
    }

    // Check user rules (deny > ask > allow priority)
    let bestMatch: PermissionResult | null = null;

    for (const rule of context.rules) {
      if (!matchesPermissionRule(rule, toolName, input)) continue;

      // deny always wins immediately
      if (rule.behavior === "deny") {
        return { behavior: "deny", reason: "Matched deny rule", matchedRule: rule };
      }

      // ask takes priority over allow
      if (rule.behavior === "ask") {
        if (!bestMatch || bestMatch.behavior === "allow") {
          bestMatch = { behavior: "ask", reason: "Matched ask rule", matchedRule: rule };
        }
      }

      // allow only if no ask/deny matched
      if (rule.behavior === "allow") {
        if (!bestMatch) {
          bestMatch = { behavior: "allow", reason: "Matched allow rule", matchedRule: rule };
        }
      }
    }

    if (bestMatch) return bestMatch;

    // No rule matched — use classifier for Bash, default ask for writes
    if (toolName === "Bash") {
      const command = input.command as string | undefined;
      if (command) {
        return classifyBashCommand(command);
      }
    }

    if (toolName === "Git") {
      const action = input.action;
      if (action === "status" || action === "diff" || action === "log" || action === "show") {
        return { behavior: "allow", reason: "Read-only git action" };
      }
      if (action === "apply" || action === "stage" || action === "commit") {
        return { behavior: "ask", reason: `Git ${String(action)} modifies repository state.` };
      }
      return { behavior: "deny", reason: `Unknown git action: ${String(action)}` };
    }

    // Read-only tools default to allow.
    if (READ_ONLY_TOOL_NAMES.has(toolName)) {
      return { behavior: "allow", reason: "Read-only tool" };
    }

    if (INTERNAL_STATE_TOOL_NAMES.has(toolName)) {
      return { behavior: "allow", reason: "Internal session state tool" };
    }

    // Agent delegation is allowed by default, but can be restricted by rules.
    if (toolName === "Agent") {
      const delegatedWriteTools = getDelegatedWriteTools(input);
      if (delegatedWriteTools.length > 0) {
        return {
          behavior: "ask",
          reason: formatDelegatedWriteReason(delegatedWriteTools),
        };
      }

      return { behavior: "allow", reason: "Agent delegation allowed by default" };
    }

    // MemoryWrite is confirmation-gated by default so project memory changes are explicit.
    if (toolName === "MemoryWrite") {
      return {
        behavior: "ask",
        reason: "Memory writes require confirmation by default. Non-interactive child runs deny write requests automatically.",
      };
    }

    if (toolName.includes(":")) {
      return classifyMcpToolPermission(toolName);
    }

    // Write tools default to ask
    return {
      behavior: "ask",
      reason: "Write operations require confirmation by default. Non-interactive child runs deny write requests automatically.",
    };
  }
}
