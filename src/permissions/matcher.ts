/**
 * Permission rule matcher.
 *
 * Supports:
 * - exact match
 * - wildcard *
 * - trailing " *" optional args
 * - escaped \* and \\
 */

import type { PermissionRule } from "./types.js";

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function getInputString(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "Bash":
      return input.command as string | undefined;
    case "FileRead":
    case "FileWrite":
    case "FileEdit":
      return input.file_path as string | undefined;
    case "Glob":
    case "Grep":
      return input.path as string | undefined;
    default:
      return JSON.stringify(input);
  }
}

function compilePattern(pattern: string): RegExp | null {
  const tokens: Array<{ kind: "literal" | "wildcard"; value?: string }> = [];

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;

    if (char === "\\") {
      i += 1;
      if (i >= pattern.length) {
        return null;
      }
      tokens.push({ kind: "literal", value: pattern[i]! });
      continue;
    }

    if (char === "*") {
      if (pattern[i + 1] === "*" && pattern[i + 2] === "/") {
        tokens.push({ kind: "literal", value: "__RECURSIVE_DIR__" });
        i += 2;
        continue;
      }
      tokens.push({ kind: "wildcard" });
      continue;
    }

    tokens.push({ kind: "literal", value: char });
  }

  const trailingOptionalArgs =
    tokens.length >= 2 &&
    tokens[tokens.length - 2]?.kind === "literal" &&
    tokens[tokens.length - 2]?.value === " " &&
    tokens[tokens.length - 1]?.kind === "wildcard";

  const effectiveTokens = trailingOptionalArgs ? tokens.slice(0, -2) : tokens;
  let regex = "^";

  for (const token of effectiveTokens) {
    if (token.kind === "wildcard") {
      regex += ".*";
      continue;
    }

    if (token.value === "__RECURSIVE_DIR__") {
      regex += "(?:.*/)?";
      continue;
    }

    regex += escapeRegexChar(token.value ?? "");
  }

  if (trailingOptionalArgs) {
    regex += "(?:\\s+.*)?";
  }

  regex += "$";

  try {
    return new RegExp(regex);
  } catch {
    return null;
  }
}

export function matchesPermissionRule(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule.toolName !== "*" && rule.toolName !== toolName) {
    return false;
  }

  if (!rule.pattern) {
    return true;
  }

  const inputStr = getInputString(toolName, input);
  if (typeof inputStr !== "string") {
    return false;
  }

  const pattern = compilePattern(rule.pattern);
  if (!pattern) {
    return false;
  }

  return pattern.test(inputStr);
}

export function compilePermissionPattern(pattern: string): RegExp | null {
  return compilePattern(pattern);
}
