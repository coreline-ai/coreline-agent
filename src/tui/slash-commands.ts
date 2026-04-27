/**
 * Slash Commands — built-in commands for the REPL.
 *
 * Commands: /help, /clear, /compact, /model, /provider, /exit, /session, /undo, /export, /watchdog, /test-loop, /scaffold, /set, /reset, /verify, /agents, /agent.
 * Multi-subcommand groups (memory, fact, link, incident, decision, runbook, prompt, skill, search-precise) are dispatched to sub-routers in `./commands/`.
 */

import { handleMemory } from "./commands/memory.js";
import { handleFact } from "./commands/fact.js";
import { handleLink } from "./commands/link.js";
import { handleIncident } from "./commands/incident.js";
import { handleDecision } from "./commands/decision.js";
import { handleRunbook } from "./commands/runbook.js";
import { handlePrompt } from "./commands/prompt.js";
import { handleSkill } from "./commands/skill.js";
import { handleSearchPrecise } from "./commands/search-precise.js";
import { handleSlopCheck } from "./commands/slop-check.js";
import { handleCritique } from "./commands/critique.js";
import { handleThemeCommand } from "./commands/theme.js";

export interface SlashCommandResult {
  handled: boolean;
  output?: string;
  action?:
    | "clear"
    | "compact"
    | "exit"
    | "switch_provider"
    | "plan"
    | "goal"
    | "autopilot"
    | "role"
    | "prompt_save"
    | "prompt_list"
    | "prompt_use"
    | "prompt_delete"
    | "search"
    | "replay"
    | "undo"
    | "export"
    | "watchdog"
    | "test_loop"
    | "scaffold_generate"
    | "runtime_set"
    | "runtime_reset"
    | "runtime_show"
    | "verify_run"
    | "skill"
    | "context"
    | "macro"
    | "parallel_agent_list"
    | "parallel_agent_status"
    | "parallel_agent_read"
    | "parallel_agent_stop"
    | "parallel_agent_resume"
    | "memory_status"
    | "memory_list"
    | "memory_read"
    | "memory_delete"
    | "memory_digest"
    | "memory_compact"
    | "memory_promote"
    | "prompt_evidence"
    | "prompt_experiment"
    | "subagent_stats"
    | "fact"
    | "memory_decay"
    | "link"
    | "search_precise"
    | "incident"
    | "decision"
    | "evidence_first"
    | "runbook"
    | "rca"
    | "memory_evidence_rotate"
    | "memory_health"
    | "brand_spec"
    | "slop_check"
    | "critique"
    | "theme_switch"
    | "theme_pick";
  data?: unknown;
}

const HELP_TEXT = `Available commands:
  /help        — Show this help
  /clear       — Clear conversation history
  /compact     — Compact context (summarize old messages)
  /model       — Show current model info
  /provider    — Switch provider (or show current)
  /role <name> — Switch active role preset
  /prompt save <name>   — Save last user input as a prompt snippet
  /prompt list          — List saved prompt snippets
  /prompt use <name>    — Paste a saved prompt snippet into input
  /prompt delete <name> — Delete a saved prompt snippet
  /prompt evidence <name> [--days N] — Show past usage evidence for a prompt
  /prompt experiment <name> [--runs N] — Inspect A/B experiment stats
  /search <query>       — Search saved session transcripts
  /replay [sessionId]   — Replay current or selected session transcript
  /export md|pr|text [sessionId] — Export current or selected session
  /undo       — Restore the most recent file backup from this session
  /watchdog status|off|<seconds> — Configure idle watchdog for this TUI session
  /scaffold <kind> <name> — Generate project boilerplate
  /set [key value] — Show or update runtime tweaks for the next turn
  /reset <key> — Reset a runtime tweak to its default
  /verify [all|typecheck|build|test] — Run background verification
  /skill list|show|use|clear|auto|status|stats — Control built-in skills
  /context current|<prompt> — Suggest relevant context files
  /macro parse <macro> — Validate a prompt macro definition
  /memory list [project|global] — List memory entries
  /memory read <name> [scope]  — Read a specific entry
  /memory delete <name> [scope] — Delete an entry
  /memory status               — Show memory status
  /memory digest               — Generate/refresh MEMORY.md digest
  /memory compact [--dry-run] [--max-chars N] — Archive old memory entries
  /memory promote [--dry-run]  — Promote high-usage recall to core
  /memory decay-apply <name> [--rate R] — Apply rounded decay
  /memory decay-list [--below T] [--include-tombstoned] — List decayed entries
  /memory decay-restore <name> — Restore tombstoned/decayed entry
  /memory decay-run [--older-than-days N] [--access-count-lt N] [--weight-gt N] [--rate R] — Batch decay
  /memory decay-tombstone <name> — Soft-delete entry
  /memory decay-is-tombstoned <name> — Check tombstone state
  /memory brand-spec init|view|edit <name> — Manage brand identity memory (logo/colors/fonts/tone)
  /slop-check <path>           — Detect AI slop signals (10 heuristic patterns) in a file
  /critique <path> [--philosophy NAME] [--strategy llm|heuristic] — 5-dimension critique (Philosophy/Hierarchy/Craft/Functionality/Originality)
  /fact add <entity> <key> <value> [--valid-from FROM] [--valid-to TO] — Add bitemporal fact
  /fact at <entity> <key> [--as-of DATE] — Look up fact at a point in time
  /fact history <entity> [<key>] — Show fact history
  /fact invalidate <entity> <key> [--invalid-at DATE] — Close open intervals
  /fact list <entity> — List all facts for an entity
  /fact keys <entity> — List recorded keys for an entity
  /link scan [<path>] — Build/refresh wiki-link forward index
  /link forward <source> — Show outbound entities from a source file
  /link graph <entity> [--hops N] — N-hop link graph for an entity
  /link orphans — List entities mentioned without a definition
  /search-precise <query> [--top-k N] [--threshold N] — Precise (exact-substring-first) search
  /incident list [--severity S] [--status S] — List incidents
  /incident show <id> — Show an incident
  /incident update <id> [--hypothesis "..."] [--confirm "..."] [--evidence "..."] — Update an incident
  /incident confirm <id> <hypothesis> — Confirm a hypothesis
  /incident resolve <id> --resolution "..." — Resolve an incident
  /decision list [--status S] [--tag T] — List decisions
  /decision show <id> — Show a decision
  /decision record --what "..." --why "..." --how "..." [--tags ...] — Record decision
  /decision update <id> --outcome "..." — Update decision outcome
  /evidence-first <query> [--limit N] — Cross-domain evidence-first search
  /runbook list [--tag T] — List runbooks
  /runbook show <id> — Show a runbook
  /runbook match <symptom> — Match runbooks against a symptom
  /runbook apply <id> [--dry-run] — Apply a runbook (dry-run by default)
  /runbook record --pattern "..." --steps "..." — Record a runbook
  /rca <incidentId> [--strategy heuristic] — Compute RCA for an incident
  /subagent stats [type]       — Show subagent performance stats
  /agents       — List parallel agent tasks
  /agent list   — List parallel agent tasks
  /agent status <id> — Show a parallel agent task status
  /agent read <id>   — Read a parallel agent task result
  /agent stop <id>   — Stop a parallel agent task
  /agent resume <id> — Resume a parallel agent task (parsed only; execution may reject)
  /plan <goal> — Run plan mode in TUI
  /goal <goal> — Run goal mode in TUI
  /autopilot <goal> — Run single-agent autopilot in TUI
  /test-loop [command] — Run explicit test-fix loop helper
  /session     — Show session info
  /exit, /quit — Exit coreline-agent`;

const ROUTERS: Array<(cmd: string, args: string[]) => SlashCommandResult | null> = [
  handleMemory,
  handleFact,
  handleLink,
  handleIncident,
  handleDecision,
  handleRunbook,
  handlePrompt,
  handleSkill,
  handleSearchPrecise,
  handleSlopCheck,
  handleCritique,
];

export function handleSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  const arg = args.join(" ");

  switch (cmd) {
    case "help":
    case "h":
      return { handled: true, output: HELP_TEXT };

    case "clear":
      return { handled: true, action: "clear", output: "Conversation cleared." };

    case "compact":
      return { handled: true, action: "compact", output: "Compacting context..." };

    case "model":
      return { handled: true, output: "[model info — populated by REPL]" };

    case "provider":
      if (arg) {
        return { handled: true, action: "switch_provider", data: arg };
      }
      return { handled: true, output: "[provider info — populated by REPL]" };

    case "role":
      if (arg) {
        return { handled: true, action: "role", data: arg };
      }
      return { handled: true, action: "role" };

    case "search":
      if (arg) {
        return { handled: true, action: "search", data: arg };
      }
      return { handled: true, output: "Usage: /search <query>" };

    case "replay":
      return { handled: true, action: "replay", data: arg || undefined };

    case "export": {
      const [formatRaw, sessionIdRaw] = args;
      const normalizedFormat = formatRaw?.toLowerCase() === "markdown"
        ? "md"
        : formatRaw?.toLowerCase();
      if (!normalizedFormat || !["md", "pr", "text"].includes(normalizedFormat)) {
        return { handled: true, output: "Usage: /export md|pr|text [sessionId]" };
      }
      return {
        handled: true,
        action: "export",
        data: {
          format: normalizedFormat,
          sessionId: sessionIdRaw,
        },
      };
    }

    case "undo":
      return { handled: true, action: "undo", output: "Undo requested." };

    case "watchdog": {
      const value = arg.trim().toLowerCase();
      if (!value || value === "status") {
        return { handled: true, action: "watchdog", data: { mode: "status" } };
      }
      if (value === "off" || value === "disable" || value === "disabled") {
        return { handled: true, action: "watchdog", data: { mode: "off" } };
      }
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { handled: true, output: "Usage: /watchdog status|off|<seconds>" };
      }
      return { handled: true, action: "watchdog", data: { mode: "set", seconds } };
    }

    case "plan":
    case "plan-mode":
      if (arg) {
        return { handled: true, action: "plan", data: arg };
      }
      return { handled: true, output: "Usage: /plan <goal>" };

    case "goal":
    case "goal-mode":
      if (arg) {
        return { handled: true, action: "goal", data: arg };
      }
      return { handled: true, output: "Usage: /goal <goal>" };

    case "autopilot":
      if (arg) {
        return { handled: true, action: "autopilot", data: arg };
      }
      return { handled: true, output: "Usage: /autopilot <goal>" };

    case "test-loop":
    case "testloop":
      return { handled: true, action: "test_loop", data: arg || undefined, output: "Test loop requested." };

    case "scaffold": {
      const [kind, ...nameParts] = args;
      const name = nameParts.join(" ").trim();
      if (!kind || !name) {
        return { handled: true, output: "Usage: /scaffold tool|provider|test|slash-command|hook <name>" };
      }
      return { handled: true, action: "scaffold_generate", data: { kind, name } };
    }

    case "set": {
      const [key, ...valueParts] = args;
      const value = valueParts.join(" ").trim();
      if (!key) {
        return { handled: true, action: "runtime_show" };
      }
      if (!value) {
        return { handled: true, output: "Usage: /set <key> <value>" };
      }
      return { handled: true, action: "runtime_set", data: { key, value } };
    }

    case "reset": {
      const [key] = args;
      if (!key) {
        return { handled: true, output: "Usage: /reset <key>" };
      }
      return { handled: true, action: "runtime_reset", data: { key } };
    }

    case "verify": {
      const target = arg.trim().toLowerCase() || "all";
      if (!["all", "typecheck", "build", "test"].includes(target)) {
        return { handled: true, output: "Usage: /verify [all|typecheck|build|test]" };
      }
      return { handled: true, action: "verify_run", data: { target } };
    }

    case "context":
      return { handled: true, action: "context", data: arg || "current" };

    case "macro": {
      const [subcommandRaw, ...macroArgs] = args;
      const subcommand = subcommandRaw?.toLowerCase();
      if (subcommand === "parse" || subcommand === "validate") {
        const value = macroArgs.join(" ");
        if (!value) return { handled: true, output: "Usage: /macro parse <macro-json-or-lines>" };
        return { handled: true, action: "macro", data: { command: "parse", value } };
      }
      return { handled: true, output: "Usage: /macro parse <macro-json-or-lines>" };
    }

    case "agents":
      if (args.length > 0) {
        return { handled: true, output: "Usage: /agents" };
      }
      return { handled: true, action: "parallel_agent_list", data: { command: "list" } };

    case "agent": {
      const [subcommandRaw, ...agentArgs] = args;
      const subcommand = subcommandRaw?.toLowerCase();
      const value = agentArgs.join(" ").trim();

      if (!subcommand) {
        return {
          handled: true,
          output: "Usage: /agent list|status <id>|read <id>|stop <id>|resume <id>",
        };
      }

      if (subcommand === "list") {
        if (value) {
          return { handled: true, output: "Usage: /agent list" };
        }
        return { handled: true, action: "parallel_agent_list", data: { command: "list" } };
      }

      if (subcommand === "status" || subcommand === "read" || subcommand === "stop" || subcommand === "resume") {
        if (!value) {
          return { handled: true, output: `Usage: /agent ${subcommand} <id>` };
        }
        const action =
          subcommand === "status"
            ? "parallel_agent_status"
            : subcommand === "read"
              ? "parallel_agent_read"
              : subcommand === "stop"
                ? "parallel_agent_stop"
                : "parallel_agent_resume";
        return { handled: true, action, data: { command: subcommand, id: value } };
      }

      return {
        handled: true,
        output: "Usage: /agent list|status <id>|read <id>|stop <id>|resume <id>",
      };
    }

    case "theme":
      return handleThemeCommand(args);

    case "session":
      return { handled: true, output: "[session info — populated by REPL]" };

    case "exit":
    case "quit":
    case "q":
      return { handled: true, action: "exit" };
  }

  // Multi-subcommand groups via sub-routers
  for (const router of ROUTERS) {
    const result = router(cmd!, args);
    if (result) return result;
  }

  return { handled: true, output: `Unknown command: /${cmd}. Type /help for available commands.` };
}
