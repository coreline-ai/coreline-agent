/**
 * Bash command classifier — categorizes shell commands by risk level.
 *
 * Reference: Claude Code's bashClassifier + yoloClassifier pattern.
 * Classifies commands as: allow (read-only), ask (potentially dangerous), deny (destructive).
 */

import type { PermissionResult } from "./types.js";
import {
  getEffectiveShellCommand,
  getDestructiveCommandWarning,
  getFilesystemMutationWarning,
  getHighRiskShellWarning,
  getPackageManagerScriptWarning,
  getPrivilegedWrapperWarning,
  hasDangerousPipeTarget,
  hasUnsafeRedirect,
  splitShellCommandList,
  splitShellPipeline,
  tokenizeShell,
  type BashSafetyWarning,
} from "./bash-safety.js";

// ---------------------------------------------------------------------------
// Read-only commands (auto-allow)
// ---------------------------------------------------------------------------

const READ_ONLY_COMMANDS = new Set([
  // File inspection
  "ls", "ll", "la", "dir", "tree", "find", "locate",
  "cat", "head", "tail", "less", "more", "bat",
  "wc", "file", "stat", "du", "df", "sort", "uniq", "cut", "tr",
  // Text search
  "grep", "rg", "ag", "ack", "fgrep", "egrep",
  // Git read operations
  "git status", "git log", "git diff", "git show", "git branch",
  "git tag", "git remote", "git stash list", "git blame",
  // System info
  "pwd", "whoami", "hostname", "uname", "date", "uptime",
  "which", "where", "type", "command",
  "echo", "printf",
  // Package info (read-only)
  "npm list", "npm ls", "npm info", "npm view", "npm outdated",
  "bun pm ls", "yarn list", "pip list", "pip show",
  // Process info
  "ps", "top", "htop",
  // Network info
  "curl -I", "ping", "dig", "nslookup", "host",
]);

// ---------------------------------------------------------------------------
// Safe write commands (auto-allow)
// ---------------------------------------------------------------------------

const SAFE_WRITE_PATTERNS = [
  // Build/test commands
  /^(npm|bun|yarn|pnpm)\s+(test|build|lint|format|typecheck|check)\b/,
  /^(npm|bun|yarn|pnpm)\s+run\s+(test|build|lint|format|typecheck|check)\b/,
  /^(tsc|eslint|prettier|jest|vitest|mocha)\b/,
  /^(make|cmake|cargo|go)\s+(build|test|run|check|fmt|lint)\b/,
  /^python\s+-m\s+(pytest|unittest|black|flake8|mypy)\b/,
  // Directory creation
  /^mkdir\s+-?p?\s+/,
  // File creation/copy (non-system paths)
  /^(touch|cp)\s+(?!\/etc|\/usr|\/sys)/,
  // Git safe writes
  /^git\s+(add|commit|stash|fetch|pull)\b/,
  /^git\s+push\b(?!.*--force)(?!.*-f)/,
  /^git\s+checkout\s+-b\b/,
  /^git\s+switch\s+(-c\s+)?/,
  /^git\s+branch\s+(?!-D)/,
  /^git\s+merge\b/,
  /^git\s+rebase\b(?!.*--force)/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isReadOnlyCommand(trimmed: string): PermissionResult | null {
  for (const cmd of READ_ONLY_COMMANDS) {
    if (trimmed === cmd || trimmed.startsWith(cmd + " ") || trimmed.startsWith(cmd + "\t")) {
      return { behavior: "allow", reason: `Read-only command: ${cmd}` };
    }
  }

  return null;
}

function isSafeWriteCommand(trimmed: string): PermissionResult | null {
  for (const pattern of SAFE_WRITE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { behavior: "allow", reason: `Safe write command: matches ${pattern.source}` };
    }
  }

  return null;
}

function getShellWords(command: string): string[] {
  return tokenizeShell(command)
    .filter((token): token is Extract<ReturnType<typeof tokenizeShell>[number], { type: "word" }> => token.type === "word")
    .map((token) => token.text);
}

function getCommandCandidates(command: string): string[] {
  const candidates = [command];
  const effectiveWords = getEffectiveShellCommand(getShellWords(command)).words;
  const effectiveCommand = effectiveWords.join(" ").trim();

  if (effectiveCommand && effectiveCommand !== command) {
    candidates.push(effectiveCommand);
  }

  return [...new Set(candidates)];
}

function formatWarningReason(prefix: string, warning: BashSafetyWarning): string {
  return `${prefix}: ${warning.message} (matched: ${warning.matched})`;
}

function rankPermission(result: PermissionResult): number {
  if (result.behavior === "deny") return 2;
  if (result.behavior === "ask") return 1;
  return 0;
}

function isSedInPlaceOption(word: string): boolean {
  if (word === "--in-place" || word.startsWith("--in-place=")) return true;
  if (!word.startsWith("-") || word.startsWith("--")) return false;
  return word.startsWith("-i") || (/^-[A-Za-z]+$/.test(word) && word.includes("i"));
}

function isSedQuietOption(word: string): boolean {
  if (word === "--quiet" || word === "--silent") return true;
  if (!word.startsWith("-") || word.startsWith("--")) return false;
  return /^-[A-Za-z]+$/.test(word) && word.includes("n");
}

function sedScriptLooksWriteCapable(script: string): boolean {
  // sed's w/e commands can write files or execute commands. Keep this narrow:
  // print-only scripts stay allow-listed; write/exec-looking scripts fall back to ask.
  return /(^|[;{}\s])(?:[0-9,$!\/\\].*)?[we](\s|$)/.test(script);
}

function sedScriptLooksPrintOnly(script: string): boolean {
  const trimmed = script.trim();
  if (!trimmed || sedScriptLooksWriteCapable(trimmed)) return false;
  return /p\s*$/.test(trimmed) || /(^|[;{}\s])p([;{}\s]|$)/.test(trimmed);
}

function classifySedCommand(command: string): PermissionResult | null {
  const words = tokenizeShell(command)
    .filter((token): token is Extract<ReturnType<typeof tokenizeShell>[number], { type: "word" }> => token.type === "word")
    .map((token) => token.text);

  if (words[0] !== "sed") return null;

  if (words.some(isSedInPlaceOption)) {
    return { behavior: "ask", reason: "sed in-place editing modifies files" };
  }

  if (words.some(isSedQuietOption) && words.some((word) => !word.startsWith("-") && sedScriptLooksPrintOnly(word))) {
    return { behavior: "allow", reason: "sed -n print command is read-only" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export function classifyBashCommand(command: string): PermissionResult {
  return classifyBashCommandInternal(command, true);
}

function classifyBashCommandInternal(command: string, allowCompound: boolean): PermissionResult {
  const trimmed = command.trim();

  if (!trimmed) {
    return { behavior: "ask", reason: "Empty command" };
  }

  const destructiveWarning = getDestructiveCommandWarning(trimmed);
  if (destructiveWarning) {
    return {
      behavior: "ask",
      reason: formatWarningReason("Potentially destructive command", destructiveWarning),
    };
  }

  const highRiskWarning = getHighRiskShellWarning(trimmed);
  if (highRiskWarning) {
    return {
      behavior: "ask",
      reason: formatWarningReason("High-risk shell pattern", highRiskWarning),
    };
  }

  const privilegedWrapperWarning = getPrivilegedWrapperWarning(trimmed);
  if (privilegedWrapperWarning) {
    return {
      behavior: "ask",
      reason: formatWarningReason("Privileged wrapper", privilegedWrapperWarning),
    };
  }

  const filesystemMutationWarning = getFilesystemMutationWarning(trimmed);
  if (filesystemMutationWarning) {
    return {
      behavior: "ask",
      reason: formatWarningReason("Filesystem mutation", filesystemMutationWarning),
    };
  }

  if (allowCompound) {
    const commandSegments = splitShellCommandList(trimmed);
    if (commandSegments.length > 1) {
      let worst: { segment: string; result: PermissionResult } | null = null;

      for (const segment of commandSegments) {
        const result = classifyBashCommandInternal(segment, false);
        if (!worst || rankPermission(result) > rankPermission(worst.result)) {
          worst = { segment, result };
        }
      }

      if (worst && worst.result.behavior !== "allow") {
        return {
          behavior: worst.result.behavior,
          reason: `Compound command uses its riskiest segment: ${worst.segment} — ${worst.result.reason ?? "requires confirmation"}`,
        };
      }

      return { behavior: "allow", reason: "Compound command contains only allowed segments" };
    }
  }

  // Check for unsafe redirects (H1: echo "data" > file)
  if (hasUnsafeRedirect(trimmed)) {
    return {
      behavior: "ask",
      reason: "Command contains redirect operator that can write files",
    };
  }

  // Check for dangerous pipe targets (H2: cat file | tee /tmp/out)
  if (hasDangerousPipeTarget(trimmed)) {
    return {
      behavior: "ask",
      reason: "Pipe chain contains potentially dangerous downstream command",
    };
  }

  const pipelineSegments = splitShellPipeline(trimmed);
  if (pipelineSegments.length > 1) {
    let worst: { segment: string; result: PermissionResult } | null = null;

    for (const segment of pipelineSegments) {
      const result = classifyBashCommandInternal(segment, false);
      if (!worst || rankPermission(result) > rankPermission(worst.result)) {
        worst = { segment, result };
      }
    }

    if (worst && worst.result.behavior !== "allow") {
      return {
        behavior: worst.result.behavior,
        reason: `Pipeline uses its riskiest segment: ${worst.segment} — ${worst.result.reason ?? "requires confirmation"}`,
      };
    }

    return { behavior: "allow", reason: "Pipeline contains only allowed segments" };
  }

  for (const candidate of getCommandCandidates(trimmed)) {
    const sedResult = classifySedCommand(candidate);
    if (sedResult) return sedResult;

    const readOnlyResult = isReadOnlyCommand(candidate);
    if (readOnlyResult) return readOnlyResult;

    const safeWriteResult = isSafeWriteCommand(candidate);
    if (safeWriteResult) return safeWriteResult;
  }

  const packageManagerScriptWarning = getPackageManagerScriptWarning(trimmed);
  if (packageManagerScriptWarning) {
    return {
      behavior: "ask",
      reason: formatWarningReason("Package manager script execution", packageManagerScriptWarning),
    };
  }

  // Default: ask for unrecognized commands
  return { behavior: "ask", reason: "Unrecognized command, requesting confirmation" };
}
