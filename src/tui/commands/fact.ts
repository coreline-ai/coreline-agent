/**
 * Fact slash sub-router — handles /fact add|at|history|invalidate|list|keys.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleFact(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd !== "fact") return null;
  const [subRaw, ...factArgs] = args;
  const sub = subRaw?.toLowerCase();
  const tokens = factArgs.filter((t) => t.length > 0);
  const positional = tokens.filter((t) => !t.startsWith("--"));
  const flagValue = (flag: string): string | undefined => {
    const idx = tokens.indexOf(flag);
    if (idx < 0) return undefined;
    const next = tokens[idx + 1];
    if (!next || next.startsWith("--")) return undefined;
    return next;
  };
  const usage = "Usage: /fact add|at|history|invalidate|list|keys <entity> ...";
  if (!sub) return { handled: true, output: usage };

  if (sub === "add") {
    const [entity, key, ...rest] = positional;
    if (!entity || !key || rest.length === 0) {
      return { handled: true, output: "Usage: /fact add <entity> <key> <value> [--valid-from FROM] [--valid-to TO]" };
    }
    const value = rest.join(" ");
    return {
      handled: true,
      action: "fact",
      data: {
        command: "add",
        entity,
        key,
        value,
        validFrom: flagValue("--valid-from"),
        validTo: flagValue("--valid-to"),
      },
    };
  }
  if (sub === "at") {
    const [entity, key] = positional;
    if (!entity || !key) {
      return { handled: true, output: "Usage: /fact at <entity> <key> [--as-of DATE]" };
    }
    return {
      handled: true,
      action: "fact",
      data: { command: "at", entity, key, asOf: flagValue("--as-of") },
    };
  }
  if (sub === "history") {
    const [entity, key] = positional;
    if (!entity) return { handled: true, output: "Usage: /fact history <entity> [<key>]" };
    return {
      handled: true,
      action: "fact",
      data: { command: "history", entity, key: key || undefined },
    };
  }
  if (sub === "invalidate") {
    const [entity, key] = positional;
    if (!entity || !key) {
      return { handled: true, output: "Usage: /fact invalidate <entity> <key> [--invalid-at DATE]" };
    }
    return {
      handled: true,
      action: "fact",
      data: { command: "invalidate", entity, key, invalidAt: flagValue("--invalid-at") },
    };
  }
  if (sub === "list") {
    const [entity] = positional;
    if (!entity) return { handled: true, output: "Usage: /fact list <entity>" };
    return { handled: true, action: "fact", data: { command: "list", entity } };
  }
  if (sub === "keys") {
    const [entity] = positional;
    if (!entity) return { handled: true, output: "Usage: /fact keys <entity>" };
    return { handled: true, action: "fact", data: { command: "keys", entity } };
  }
  return { handled: true, output: usage };
}
