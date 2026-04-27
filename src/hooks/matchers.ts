import type { HookConfig, HookInput } from "./types.js";

export function matchesHook(config: Pick<HookConfig, "event" | "matcher" | "if">, input: HookInput): boolean {
  if (config.event !== input.event) return false;
  if (config.matcher && !matchesPattern(getMatchTarget(input), config.matcher)) return false;
  if (config.if && !matchesIfExpression(config.if, input)) return false;
  return true;
}

export function matchesPattern(value: string | undefined, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  if (!value) return false;
  if (normalizedPattern.includes("*")) {
    return wildcardToRegExp(normalizedPattern).test(value);
  }
  return value === normalizedPattern || value.includes(normalizedPattern);
}

export function matchesIfExpression(expression: string, input: HookInput): boolean {
  const parsed = parseIfExpression(expression);
  if (!parsed) return false;
  const toolName = "toolName" in input ? input.toolName : input.action;
  if (parsed.toolName !== "*" && toolName !== parsed.toolName) return false;
  return matchesPattern(getActionTarget(input), parsed.pattern || "*");
}

export function parseIfExpression(expression: string): { toolName: string; pattern: string } | null {
  const trimmed = expression.trim();
  const match = /^([A-Za-z0-9_*.-]+)\((.*)\)$/.exec(trimmed);
  if (!match) return null;
  const toolName = match[1]?.trim();
  const pattern = match[2]?.trim() ?? "";
  if (!toolName) return null;
  return { toolName, pattern: pattern || "*" };
}

function getMatchTarget(input: HookInput): string | undefined {
  return getActionTarget(input) ?? ("toolName" in input ? input.toolName : undefined) ?? ("status" in input ? input.status : undefined);
}

function getActionTarget(input: HookInput): string | undefined {
  if (input.action) return input.action;
  if (typeof input.target === "string") return input.target;
  if ("input" in input) {
    const value = input.input;
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      for (const key of ["command", "file_path", "path", "query", "pattern", "prompt"]) {
        const candidate = rec[key];
        if (typeof candidate === "string") return candidate;
      }
    }
  }
  return undefined;
}

function wildcardToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map(escapeRegExp)
    .join(".*");
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
