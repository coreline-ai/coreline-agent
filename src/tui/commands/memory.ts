/**
 * Memory slash sub-router — handles /memory list/read/delete/digest/compact/promote/decay-(apply|list|...)/status.
 */
import type { SlashCommandResult } from "../slash-commands.js";

export function handleMemory(cmd: string, args: string[]): SlashCommandResult | null {
  if (cmd !== "memory") return null;
  const [sub, ...memArgs] = args;
  const memArg = memArgs.join(" ");
  if (!sub || sub === "status") {
    return { handled: true, action: "memory_status" };
  }
  if (sub === "list") {
    const scope = memArg === "global" ? "global" : memArg === "project" ? "project" : undefined;
    return { handled: true, action: "memory_list", data: scope };
  }
  if (sub === "read" && memArg) {
    const parts = memArg.split(/\s+/);
    const name = parts[0];
    const scope = parts[1] === "global" ? "global" : parts[1] === "project" ? "project" : undefined;
    return { handled: true, action: "memory_read", data: { name, scope } };
  }
  if (sub === "delete" && memArg) {
    const parts = memArg.split(/\s+/);
    const name = parts[0];
    const scope = parts[1] === "global" ? "global" : parts[1] === "project" ? "project" : undefined;
    return { handled: true, action: "memory_delete", data: { name, scope } };
  }
  if (sub === "digest") {
    return { handled: true, action: "memory_digest" };
  }
  if (sub === "compact") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const dryRun = tokens.includes("--dry-run");
    const maxCharsIdx = tokens.indexOf("--max-chars");
    const maxChars = maxCharsIdx >= 0 && tokens[maxCharsIdx + 1]
      ? Number(tokens[maxCharsIdx + 1])
      : undefined;
    return {
      handled: true,
      action: "memory_compact",
      data: { dryRun, maxChars: Number.isFinite(maxChars) ? maxChars : undefined },
    };
  }
  if (sub === "promote") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const dryRun = tokens.includes("--dry-run");
    return { handled: true, action: "memory_promote", data: { dryRun } };
  }
  if (sub === "decay-apply") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const name = tokens.find((t) => !t.startsWith("--"));
    if (!name) return { handled: true, output: "Usage: /memory decay-apply <name> [--rate R]" };
    const rateIdx = tokens.indexOf("--rate");
    const rateRaw = rateIdx >= 0 && tokens[rateIdx + 1] ? Number(tokens[rateIdx + 1]) : undefined;
    return {
      handled: true,
      action: "memory_decay",
      data: { command: "apply", name, rate: Number.isFinite(rateRaw) ? rateRaw : undefined },
    };
  }
  if (sub === "decay-list") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const belowIdx = tokens.indexOf("--below");
    const belowRaw = belowIdx >= 0 && tokens[belowIdx + 1] ? Number(tokens[belowIdx + 1]) : undefined;
    const includeTombstoned = tokens.includes("--include-tombstoned");
    return {
      handled: true,
      action: "memory_decay",
      data: {
        command: "list",
        below: Number.isFinite(belowRaw) ? belowRaw : undefined,
        includeTombstoned,
      },
    };
  }
  if (sub === "decay-restore") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const name = tokens.find((t) => !t.startsWith("--"));
    if (!name) return { handled: true, output: "Usage: /memory decay-restore <name>" };
    return {
      handled: true,
      action: "memory_decay",
      data: { command: "restore", name },
    };
  }
  if (sub === "decay-run") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const olderIdx = tokens.indexOf("--older-than-days");
    const accessIdx = tokens.indexOf("--access-count-lt");
    const weightIdx = tokens.indexOf("--weight-gt");
    const rateIdx = tokens.indexOf("--rate");
    const olderRaw = olderIdx >= 0 && tokens[olderIdx + 1] ? Number(tokens[olderIdx + 1]) : undefined;
    const accessRaw = accessIdx >= 0 && tokens[accessIdx + 1] ? Number(tokens[accessIdx + 1]) : undefined;
    const weightRaw = weightIdx >= 0 && tokens[weightIdx + 1] ? Number(tokens[weightIdx + 1]) : undefined;
    const rateRaw = rateIdx >= 0 && tokens[rateIdx + 1] ? Number(tokens[rateIdx + 1]) : undefined;
    return {
      handled: true,
      action: "memory_decay",
      data: {
        command: "run",
        olderThanDays: Number.isFinite(olderRaw) ? olderRaw : undefined,
        accessCountLt: Number.isFinite(accessRaw) ? accessRaw : undefined,
        weightGt: Number.isFinite(weightRaw) ? weightRaw : undefined,
        rate: Number.isFinite(rateRaw) ? rateRaw : undefined,
      },
    };
  }
  if (sub === "decay-tombstone") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const name = tokens.find((t) => !t.startsWith("--"));
    if (!name) return { handled: true, output: "Usage: /memory decay-tombstone <name>" };
    return {
      handled: true,
      action: "memory_decay",
      data: { command: "tombstone", name },
    };
  }
  if (sub === "evidence-rotate") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const dryRun = tokens.includes("--dry-run");
    return {
      handled: true,
      action: "memory_evidence_rotate",
      data: { dryRun },
    };
  }
  if (sub === "health") {
    return { handled: true, action: "memory_health" };
  }
  if (sub === "brand-spec") {
    const [action, ...rest] = memArgs.slice(1);
    if (!action || !["init", "view", "edit"].includes(action)) {
      return {
        handled: true,
        output: "Usage: /memory brand-spec init|view|edit <name>",
      };
    }
    const name = rest.join(" ").trim();
    if (!name) {
      return {
        handled: true,
        output: `Usage: /memory brand-spec ${action} <name>`,
      };
    }
    return {
      handled: true,
      action: "brand_spec",
      data: { command: action as "init" | "view" | "edit", name },
    };
  }
  if (sub === "decay-is-tombstoned") {
    const tokens = memArg.split(/\s+/).filter(Boolean);
    const name = tokens.find((t) => !t.startsWith("--"));
    if (!name) return { handled: true, output: "Usage: /memory decay-is-tombstoned <name>" };
    return {
      handled: true,
      action: "memory_decay",
      data: { command: "isTombstoned", name },
    };
  }
  return {
    handled: true,
    output:
      `Usage: /memory list [project|global] | /memory read <name> [project|global] | /memory delete <name> [project|global] | /memory status | ` +
      `/memory digest | /memory compact [--dry-run] [--max-chars N] | /memory promote [--dry-run] | ` +
      `/memory decay-apply <name> [--rate R] | /memory decay-list [--below T] [--include-tombstoned] | ` +
      `/memory decay-restore <name> | /memory decay-run [--older-than-days N] [--access-count-lt N] [--weight-gt N] [--rate R] | ` +
      `/memory decay-tombstone <name> | /memory decay-is-tombstoned <name> | ` +
      `/memory brand-spec init|view|edit <name>`,
  };
}
