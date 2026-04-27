/**
 * Link slash sub-router — handles /link scan|forward|graph|orphans.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleLink(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd !== "link") return null;
  const [subRaw, ...linkArgs] = args;
  const sub = subRaw?.toLowerCase();
  const tokens = linkArgs.filter((t) => t.length > 0);
  const positional = tokens.filter((t) => !t.startsWith("--"));
  const flagValue = (flag: string): string | undefined => {
    const idx = tokens.indexOf(flag);
    if (idx < 0) return undefined;
    const next = tokens[idx + 1];
    if (!next || next.startsWith("--")) return undefined;
    return next;
  };
  const usage = "Usage: /link scan [<path>] | /link forward <source> | /link graph <entity> [--hops N] | /link orphans";
  if (!sub) return { handled: true, output: usage };

  if (sub === "scan") {
    return {
      handled: true,
      action: "link",
      data: { command: "scan", path: positional[0] },
    };
  }
  if (sub === "forward") {
    const source = positional[0];
    if (!source) return { handled: true, output: "Usage: /link forward <source>" };
    return { handled: true, action: "link", data: { command: "forward", source } };
  }
  if (sub === "graph") {
    const entity = positional[0];
    if (!entity) return { handled: true, output: "Usage: /link graph <entity> [--hops N]" };
    const hopsRaw = flagValue("--hops");
    const hops = hopsRaw !== undefined ? Number(hopsRaw) : undefined;
    return {
      handled: true,
      action: "link",
      data: {
        command: "graph",
        entity,
        hops: Number.isFinite(hops as number) ? hops : undefined,
      },
    };
  }
  if (sub === "orphans") {
    return { handled: true, action: "link", data: { command: "orphans" } };
  }
  return { handled: true, output: usage };
}
