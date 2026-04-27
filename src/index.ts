#!/usr/bin/env bun
/**
 * coreline-agent — Multi-provider coding agent TUI
 *
 * CLI entrypoint: parses arguments, loads config, launches TUI or one-shot mode.
 */

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { createAppState } from "./agent/context.js";
import { BackupStore } from "./agent/file-backup.js";
import { CostTracker } from "./agent/cost-tracker.js";
import { ToolCache } from "./agent/tool-cache.js";
import { StatusTracker } from "./agent/status.js";
import { createLifecycle, type LifecycleController } from "./agent/lifecycle.js";
import { createDigestListener } from "./agent/lifecycle-digest.js";
import { finalizeAllSessions } from "./agent/self-improve/session-lifecycle-hooks.js";
import { agentLoop } from "./agent/loop.js";
import { buildPlan, executePlan, runAutopilot, type PlanExecutionResult, type AutopilotRunResult, type AutopilotDecisionRecord } from "./agent/plan-execute/index.js";
import { runTestFixLoopToCompletion } from "./agent/test-loop.js";
import { parseWatchdogTimeoutSeconds, ProgressWatchdog } from "./agent/watchdog.js";
import type { PlanExecutionContext, PlanExecutionStep, Task, TaskOutput } from "./agent/plan-execute/types.js";
import { buildResumeAdvice, buildVerificationPack, createRecoveryCheckpoint, judgePlanExecutionCompletion } from "./agent/reliability/index.js";
import { createRootSubAgentRuntime } from "./agent/subagent-root.js";
import { ParallelAgentScheduler } from "./agent/parallel/scheduler.js";
import { DEFAULT_MAX_PARALLEL_AGENT_TASKS } from "./agent/parallel/types.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { listBuiltInSkills, formatSkillForDisplay, getBuiltInSkill } from "./skills/registry.js";
import { selectBuiltInSkills } from "./skills/router.js";
import type { BuiltInSkillId } from "./skills/types.js";
import { instantiateProvider, ProviderRegistryImpl } from "./providers/registry.js";
import {
  loadProviders,
  loadPermissions,
  loadSettings,
  resolveDefaultProviderName,
  resolveMaxTurns,
} from "./config/loader.js";
import { loadRole, type Role } from "./config/roles.js";
import { ensureConfigDirs } from "./config/paths.js";
import {
  McpConnectionManager,
  getEnabledMcpServers,
  loadMcpConfigWithStatus,
  type McpConfigLoadSnapshot,
  type McpConnectionManagerStatusSnapshot,
} from "./mcp/index.js";
import { SessionManager } from "./session/history.js";
import { exportSessionMarkdown, exportSessionPrDescription, exportSessionToText } from "./session/export.js";
import { getLatestSessionId } from "./session/storage.js";
import { launchTUI } from "./tui/app.js";
import type { ProxyStatus } from "./tui/status-bar.js";
import { formatAtFileIssues, prepareUserPrompt } from "./prompt/index.js";
import { createMcpToolBridgeToolsFromInventory } from "./tools/mcp/index.js";
import { createMcpResourceTools } from "./tools/mcp-resources/index.js";
import { mergePromptAndStdin, readStdinIfPiped } from "./utils/stdin.js";
import type { ProviderConfig } from "./providers/types.js";
import type { Tool } from "./tools/types.js";
import type { PlanRunMode, PlanRunRecord, PlanRunStatus } from "./session/records.js";
import { startProxyServer, type ProxyServerHandle } from "./proxy/server.js";

// Tools
import { BashTool } from "./tools/bash/bash-tool.js";
import { FileReadTool } from "./tools/file-read/file-read-tool.js";
import { FileWriteTool } from "./tools/file-write/file-write-tool.js";
import { FileEditTool } from "./tools/file-edit/file-edit-tool.js";
import { GlobTool } from "./tools/glob/glob-tool.js";
import { GrepTool } from "./tools/grep/grep-tool.js";
import { MemoryReadTool } from "./tools/memory-read/memory-read-tool.js";
import { MemoryWriteTool } from "./tools/memory-write/memory-write-tool.js";
import { MemoryRecallTool } from "./tools/memory-recall/memory-recall-tool.js";
import { IngestDocumentTool } from "./tools/ingest-document/ingest-document-tool.js";
import { ProjectMemory } from "./memory/project-memory.js";
import { AgentTool } from "./tools/agent/agent-tool.js";
import { GitTool } from "./tools/git/git-tool.js";
import { TodoWriteTool } from "./tools/todo-write/index.js";
import { AskUserQuestionTool } from "./tools/ask-user-question/index.js";

const VERSION = "0.1.0";
const BASE_TOOLS: Tool[] = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  MemoryReadTool,
  MemoryWriteTool,
  MemoryRecallTool,
  IngestDocumentTool,
  AgentTool,
  GitTool,
  TodoWriteTool,
  AskUserQuestionTool,
];

let runtimeLifecycle: LifecycleController | null = null;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command()
  .name("coreline-agent")
  .description(
    "Multi-provider coding agent TUI — connect Claude, OpenAI, Gemini, and local LLMs via a single interface",
  )
  .version(VERSION, "-v, --version")
  .option("--provider <name>", "LLM provider to use (overrides default)")
  .option("--model <id>", "model ID to use (overrides provider default)")
  .option("-p, --prompt <text>", "run a single prompt and exit (non-interactive)")
  .option("--resume [sessionId]", "resume a previous session")
  .option("--json", "output agent events as NDJSON (for piping)")
  .option("--verbose", "enable debug logging")
  .option("--show-reasoning", "show model reasoning/thinking output (default: true in TUI)")
  .option("--no-reasoning", "hide model reasoning/thinking output")
  .option("--no-auto-summary", "disable automatic memory summaries at the end of completed conversations")
  .option("--plan-mode", "enable future plan/execute/evaluate mode when supported")
  .option("--goal-mode", "enable goal-mode UI/CLI entry when supported")
  .option("--autopilot", "enable single-agent autopilot mode in non-interactive or TUI goal flows")
  .option("--test-loop [command]", "run the explicit test loop helper and exit")
  .option("--budget <dollars>", "warn when tracked model usage exceeds this session budget")
  .option("--budget-stop", "stop the current agent loop when --budget is exceeded")
  .option("--export-session <sessionId>", "export a saved session and exit (use 'latest' for newest)")
  .option("--export-format <format>", "session export format: md, pr, or text (default: md)")
  .option("--watchdog-timeout <seconds>", "abort a one-shot chat loop if no progress is observed for N seconds")
  .option("--role <name>", "active role preset to inject into the system prompt")
  .option("--skill <ids>", "explicit built-in skill ids to inject, comma-separated")
  .option("--no-auto-skills", "disable automatic built-in skill selection")
  .option("--list-skills", "list built-in skills and exit")
  .option("--show-skill <id>", "show one built-in skill and exit")
  .option("--macro <name>", "reserved prompt macro entry point (currently parsed for help/compatibility)")
  .option("--benchmark", "reserved deterministic benchmark entry point (currently parsed for help/compatibility)")
  .option("--proxy [url]", "start a local proxy (no value) or show status for an existing proxy URL")
  .option("--max-turns <n>", "max agent loop turns (default: 50)");

program.parse(process.argv);

const opts = program.opts<{
  provider?: string;
  model?: string;
  prompt?: string;
  resume?: string | true;
  json?: boolean;
  verbose?: boolean;
  reasoning?: boolean; // commander's --no-reasoning → reasoning: false
  showReasoning?: boolean;
  autoSummary?: boolean;
  planMode?: boolean;
  goalMode?: boolean;
  autopilot?: boolean;
  testLoop?: string | true;
  budget?: string;
  budgetStop?: boolean;
  exportSession?: string;
  exportFormat?: string;
  watchdogTimeout?: string;
  role?: string;
  skill?: string;
  autoSkills?: boolean;
  listSkills?: boolean;
  showSkill?: string;
  macro?: string;
  benchmark?: boolean;
  proxy?: string | true;
  maxTurns?: string;
}>();

// Default: show reasoning (unless --no-reasoning is given)
const showReasoning = opts.reasoning !== false;
if (opts.autoSummary === false) {
  process.env.CORELINE_NO_AUTO_SUMMARY = "1";
}

function parseSkillIds(value: string | undefined): BuiltInSkillId[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => {
      const skill = listBuiltInSkills().find((entry) => entry.id === id);
      if (!skill) {
        throw new Error(`Unknown built-in skill: ${id}`);
      }
      return skill.id;
    });
}

function shouldAutoSelectSkillsForMode(mode: "chat" | "one-shot" | "plan" | "goal" | "autopilot", autoSkillsEnabled: boolean): boolean {
  if (!autoSkillsEnabled) return false;
  // Built-in skills must not unexpectedly reshape planner/evaluator/autopilot behavior.
  return mode === "chat" || mode === "one-shot";
}

if (opts.listSkills) {
  console.log(
    listBuiltInSkills()
      .map((skill) => `${skill.id}\t${skill.title}\t${skill.summary}`)
      .join("\n"),
  );
  process.exit(0);
}

if (opts.showSkill) {
  if (!getBuiltInSkill(opts.showSkill)) {
    console.error(`[coreline-agent] Unknown built-in skill: ${opts.showSkill}`);
    process.exit(1);
  }
  console.log(formatSkillForDisplay(opts.showSkill));
  process.exit(0);
}

let cliExplicitSkillIds: BuiltInSkillId[] = [];
try {
  cliExplicitSkillIds = parseSkillIds(opts.skill);
} catch (error) {
  console.error(`[coreline-agent] ${(error as Error).message}`);
  process.exit(1);
}

function parseBudgetOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --budget value: ${value}`);
  }
  return parsed;
}

type SessionExportFormat = "md" | "pr" | "text";

function parseSessionExportFormat(value: string | undefined): SessionExportFormat {
  const normalized = (value ?? "md").trim().toLowerCase();
  if (normalized === "markdown") return "md";
  if (normalized === "md" || normalized === "pr" || normalized === "text") return normalized;
  throw new Error(`Invalid --export-format value: ${value}. Expected md, pr, or text.`);
}

function resolveSessionExportId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--export-session requires a session id.");
  }
  if (trimmed === "latest") {
    const latest = getLatestSessionId();
    if (!latest) {
      throw new Error("No saved sessions found to export.");
    }
    return latest;
  }
  return trimmed;
}

function renderSessionExport(sessionId: string, format: SessionExportFormat): string {
  if (format === "pr") return exportSessionPrDescription(sessionId);
  if (format === "text") return exportSessionToText(sessionId);
  return exportSessionMarkdown(sessionId);
}

function parseWatchdogOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseWatchdogTimeoutSeconds(value);
  if (parsed === undefined) {
    throw new Error(`Invalid --watchdog-timeout value: ${value}`);
  }
  return parsed;
}

const positionalPrompt = program.args.join(" ");
const modeFlags = [opts.planMode, opts.goalMode, opts.autopilot].filter(Boolean).length;
if (modeFlags > 1) {
  console.error("[coreline-agent] --plan-mode, --goal-mode, and --autopilot are mutually exclusive.");
  process.exit(1);
}
// ---------------------------------------------------------------------------
// Env-based fallback provider detection
// ---------------------------------------------------------------------------

function resolveFallbackProvider(): ProviderConfig | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: "claude", type: "anthropic", model: "claude-sonnet-4-20250514", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai", type: "openai", model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.GOOGLE_API_KEY) {
    return { name: "gemini", type: "gemini", model: "gemini-2.5-pro", apiKey: process.env.GOOGLE_API_KEY };
  }
  return null;
}

async function resolveRuntimeTools(verbose = false): Promise<{
  tools: Tool[];
  mcpManager?: McpConnectionManager;
  mcpLoad: McpConfigLoadSnapshot;
  mcpStatus?: McpConnectionManagerStatusSnapshot;
  mcpToolCount: number;
}> {
  const tools = [...BASE_TOOLS];
  const mcpLoad = loadMcpConfigWithStatus();
  const enabledServers = getEnabledMcpServers(mcpLoad.config);

  if (enabledServers.length === 0) {
    return { tools, mcpLoad, mcpToolCount: 0 };
  }

  const manager = new McpConnectionManager(mcpLoad.config);
  const mcpResourceTools = createMcpResourceTools({ manager });

  try {
    const inventory = await manager.listAllTools();
    if (inventory.length === 0) {
      return {
        tools: [...tools, ...mcpResourceTools],
        mcpManager: manager,
        mcpLoad,
        mcpStatus: manager.getStatusSnapshot(),
        mcpToolCount: mcpResourceTools.length,
      };
    }

    const mcpTools = await createMcpToolBridgeToolsFromInventory(
      inventory,
      async (toolName, input, entry) => manager.callTool(entry.serverName, toolName, input),
    );

    if (verbose) {
      console.error(
        `[coreline-agent] loaded ${mcpTools.length} MCP tools from ${enabledServers.length} server(s)`,
      );
    }

    return {
      tools: [...tools, ...mcpResourceTools, ...mcpTools],
      mcpManager: manager,
      mcpLoad,
      mcpStatus: manager.getStatusSnapshot(),
      mcpToolCount: mcpResourceTools.length + mcpTools.length,
    };
  } catch (error) {
    if (verbose) {
      console.error(`[coreline-agent] MCP tools unavailable: ${(error as Error).message}`);
    }
    const snapshot = manager.getStatusSnapshot();
    return {
      tools: [...tools, ...mcpResourceTools],
      mcpManager: manager,
      mcpLoad,
      mcpStatus: snapshot,
      mcpToolCount: mcpResourceTools.length,
    };
  }
}

function summarizeMcpUiState(
  load: McpConfigLoadSnapshot,
  status: McpConnectionManagerStatusSnapshot | undefined,
  loadedToolCount: number,
): string {
  if (load.state === "missing") {
    return "none";
  }

  if (load.state === "invalid") {
    return "invalid";
  }

  const enabledCount = status?.selection.enabledServerNames.length ?? getEnabledMcpServers(load.config).length;
  if (enabledCount === 0) {
    return "disabled";
  }

  const selected = status?.selection.selectedServerName ?? load.config.defaultServer;
  const serverLabel = selected ?? `${enabledCount}srv`;
  return `${serverLabel}/${loadedToolCount}t`;
}

async function resolveProxyStatus(
  proxyOption: string | true | undefined,
  providerRegistry: ProviderRegistryImpl,
  verbose = false,
  statusTracker?: StatusTracker,
): Promise<{ proxyStatus?: ProxyStatus; proxyHandle?: ProxyServerHandle }> {
  if (!proxyOption) {
    return {};
  }

  if (proxyOption === true) {
    const handle = startProxyServer({
      registry: providerRegistry,
      statusTracker,
      log: verbose ? (line) => console.error(line) : () => undefined,
    });

    return {
      proxyHandle: handle,
      proxyStatus: {
        url: handle.url,
        providerCount: providerRegistry.listProviders().length,
        isListening: true,
      },
    };
  }

  try {
    const response = await fetch(new URL("/health", proxyOption));
    if (!response.ok) {
      return {
        proxyStatus: {
          url: proxyOption,
          providerCount: 0,
          isListening: false,
        },
      };
    }

    const body = (await response.json()) as { providers?: string[] };
    return {
      proxyStatus: {
        url: proxyOption,
        providerCount: Array.isArray(body.providers) ? body.providers.length : 0,
        isListening: true,
      },
    };
  } catch {
    return {
      proxyStatus: {
        url: proxyOption,
        providerCount: 0,
        isListening: false,
      },
    };
  }
}

function formatPlanExecution(result: PlanExecutionResult, taskOutputs: Map<string, string>): string {
  return formatExecution(result, taskOutputs, "plan");
}

function clonePlanTask<T extends { dependsOn: string[] }>(task: T): T {
  return {
    ...task,
    dependsOn: [...task.dependsOn],
  };
}

function clonePlanRecord(record: PlanRunRecord): PlanRunRecord {
  return {
    ...record,
    decisionLog: record.decisionLog ? record.decisionLog.map((entry) => ({ ...entry })) : undefined,
    plan: {
      goal: record.plan.goal,
      tasks: record.plan.tasks.map((task) => clonePlanTask(task)),
    },
    steps: record.steps.map((step) => ({
      ...step,
      task: clonePlanTask(step.task),
      output: step.output
        ? {
            ...step.output,
            artifacts: step.output.artifacts ? step.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
          }
        : undefined,
      evaluation: step.evaluation ? { ...step.evaluation } : undefined,
    })),
    summary: record.summary ? { ...record.summary } : undefined,
  };
}

function summarizePlanRecord(record: PlanRunRecord): NonNullable<PlanRunRecord["summary"]> {
  return {
    completed: record.plan.tasks.filter((task) => task.status === "completed").length,
    failed: record.plan.tasks.filter((task) => task.status === "failed").length,
    ambiguous: record.steps.filter((step) => step.evaluation?.outcome === "ambiguous").length,
    verified: record.plan.tasks.filter((task) => task.status === "verified").length,
  };
}

function updateStoredPlanRunStep(
  record: PlanRunRecord,
  taskId: string,
  patch: {
    taskStatus?: PlanRunRecord["plan"]["tasks"][number]["status"];
    result?: unknown;
    output?: PlanRunRecord["steps"][number]["output"];
    evaluation?: PlanRunRecord["steps"][number]["evaluation"];
    activeTaskId?: string;
    nextAction?: string;
    recoveryAction?: PlanRunRecord["recoveryAction"];
    status?: PlanRunRecord["status"];
    error?: string;
    completed?: boolean;
    resumeEligible?: boolean;
    lastVerificationSummary?: string;
    lastFailureClass?: PlanRunRecord["lastFailureClass"];
    lastFailureReason?: string;
    lastRecoveryRationale?: string;
  },
): PlanRunRecord {
  const next = clonePlanRecord(record);
  const taskIndex = next.plan.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex !== -1) {
    next.plan.tasks[taskIndex] = {
      ...next.plan.tasks[taskIndex]!,
      status: patch.taskStatus ?? next.plan.tasks[taskIndex]!.status,
    };
  }

  const stepIndex = next.steps.findIndex((step) => step.task.id === taskId);
  if (stepIndex === -1) {
    const planTask = next.plan.tasks.find((task) => task.id === taskId);
    next.steps.push({
      task: planTask ? clonePlanTask(planTask) : { id: taskId, description: taskId, dependsOn: [], status: patch.taskStatus ?? "pending" },
      result: patch.result,
      output: patch.output,
      evaluation: patch.evaluation,
    });
  } else {
    next.steps[stepIndex] = {
      task: {
        ...next.steps[stepIndex]!.task,
        status: patch.taskStatus ?? next.steps[stepIndex]!.task.status,
      },
      result: patch.result ?? next.steps[stepIndex]!.result,
      output: patch.output ?? next.steps[stepIndex]!.output,
      evaluation: patch.evaluation ?? next.steps[stepIndex]!.evaluation,
    };
  }

  next.summary = summarizePlanRecord(next);
  next.activeTaskId = patch.activeTaskId ?? next.activeTaskId;
  next.nextAction = patch.nextAction ?? next.nextAction;
  next.recoveryAction = patch.recoveryAction ?? next.recoveryAction;
  next.status = patch.status ?? next.status;
  next.error = patch.error ?? next.error;
  next.completed = patch.completed ?? next.completed;
  next.resumeEligible = patch.resumeEligible ?? next.resumeEligible;
  next.lastVerificationSummary = patch.lastVerificationSummary ?? next.lastVerificationSummary;
  next.lastFailureClass = patch.lastFailureClass ?? next.lastFailureClass;
  next.lastFailureReason = patch.lastFailureReason ?? next.lastFailureReason;
  next.lastRecoveryRationale = patch.lastRecoveryRationale ?? next.lastRecoveryRationale;
  return next;
}

function findNextActiveTaskId(record: PlanRunRecord): string | undefined {
  return record.plan.tasks.find((task) => task.status !== "completed" && task.status !== "verified")?.id;
}

function formatExecution(
  result: PlanExecutionResult,
  taskOutputs: Map<string, string>,
  mode: PlanRunMode = "plan",
): string {
  const heading = mode === "goal" ? "Goal" : "Plan";
  const lines = [
    `${heading}: ${result.plan.goal}`,
    "",
    "Steps:",
    ...result.plan.tasks.map((task) => {
      const marker = task.status === "completed" || task.status === "verified"
        ? "✓"
        : task.status === "needs_user"
          ? "!"
          : task.status === "blocked"
            ? "⧖"
            : task.status === "failed"
              ? "✗"
              : "•";
      const summary = task.output?.summary?.trim();
      const reason =
        summary
        ?? (typeof task.result === "object" &&
        task.result !== null &&
        "reason" in task.result &&
        typeof (task.result as { reason?: unknown }).reason === "string"
          ? (task.result as { reason: string }).reason
          : "");
      return `${marker} ${task.id}: ${task.description}${reason ? ` — ${reason}` : ""}`;
    }),
    "",
    `Summary: completed=${result.summary.completed}, failed=${result.summary.failed}, ambiguous=${result.summary.ambiguous}`,
  ];

  const completedOutputs = [...taskOutputs.entries()].filter(([, text]) => text.trim().length > 0);
  if (completedOutputs.length > 0) {
    lines.push("", "Task outputs:");
    for (const [taskId, text] of completedOutputs) {
      lines.push(`- ${taskId}: ${text.trim()}`);
    }
  }

  const verifiedTasks = result.plan.tasks.filter((task) => task.verification?.status === "passed" || task.verification?.status === "ambiguous");
  if (verifiedTasks.length > 0) {
    lines.push("", "What was verified:");
    for (const task of verifiedTasks) {
      const summary = task.verification?.summary?.trim() || task.output?.verificationSummary?.trim();
      lines.push(`- ${task.id}: ${summary || task.status}`);
    }
  }

  const remainingTasks = result.plan.tasks.filter((task) => task.status !== "completed" && task.status !== "verified");
  if (remainingTasks.length > 0) {
    lines.push("", "What remains:");
    for (const task of remainingTasks) {
      lines.push(`- ${task.id}: ${task.nextAction ?? task.status}`);
    }
  }

  return lines.join("\n");
}

function formatCompletedOutputsForPrompt(execution: PlanExecutionContext): string | null {
  const lines: string[] = [];
  for (const [taskId, output] of execution.completedOutputs.entries()) {
    const summary = output.summary?.trim() || output.verificationSummary?.trim();
    if (summary) {
      lines.push(`- ${taskId}: ${summary}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function derivePlanRunStatus(result: PlanExecutionResult, error?: string): PlanRunStatus {
  if (error) return "failed";
  if (result.plan.tasks.some((task) => task.status === "needs_user")) return "needs_user";
  if (result.plan.tasks.some((task) => task.status === "blocked")) return "blocked";
  if (result.plan.tasks.some((task) => task.status === "aborted")) return "aborted";
  if (result.completed) return "completed";
  if (result.plan.tasks.some((task) => task.status === "failed")) return "failed";
  return "running";
}

function buildPlanRunContextFromResult(result: PlanExecutionResult): Pick<
  PlanRunRecord,
  "lastVerificationSummary" | "lastFailureClass" | "lastFailureReason" | "lastRecoveryRationale"
> {
  const lastStep = [...result.steps].reverse().find((step) => step.task.status !== "pending" || step.result !== undefined);
  return {
    lastVerificationSummary: lastStep?.task.verification?.summary?.trim()
      ?? lastStep?.output?.verificationSummary?.trim()
      ?? lastStep?.output?.summary?.trim(),
    lastFailureClass: lastStep?.task.status === "blocked"
      || lastStep?.task.status === "needs_user"
      || lastStep?.task.status === "failed"
      || lastStep?.task.status === "aborted"
      ? lastStep.task.status
      : undefined,
    lastFailureReason: lastStep?.task.failureReason?.trim()
      ?? lastStep?.task.recovery?.lastFailureReason?.trim()
      ?? lastStep?.task.recovery?.reason?.trim()
      ?? lastStep?.evaluation?.reason?.trim(),
    lastRecoveryRationale: lastStep?.task.recovery?.reason?.trim()
      ?? lastStep?.task.nextAction?.trim(),
  };
}

function createStoredPlanRunRecord(
  sessionId: string,
  result: PlanExecutionResult,
  taskOutputs: Map<string, string>,
  details: {
    prompt: string;
    providerName: string;
    model: string;
    cwd: string;
    source: "cli" | "tui";
    mode?: PlanRunMode;
    planRunId?: string;
    error?: string;
    cycleCount?: number;
    decisionLog?: AutopilotDecisionRecord[];
    stopReason?: string;
  },
): PlanRunRecord {
  const mode = details.mode ?? "plan";
  const runContext = buildPlanRunContextFromResult(result);
  const record: PlanRunRecord = {
    _type: "plan_run",
    planRunId: details.planRunId ?? randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    source: details.source,
    cwd: details.cwd,
    providerName: details.providerName,
    model: details.model,
    prompt: details.prompt,
    mode: mode === "goal" || mode === "autopilot" ? mode : undefined,
    resumeEligible: mode === "goal" || mode === "autopilot" ? true : undefined,
    goal: result.plan.goal,
    cycleCount: details.cycleCount,
    decisionLog: details.decisionLog ? details.decisionLog.map((entry) => ({ ...entry })) : undefined,
    stopReason: details.stopReason,
    plan: {
      goal: result.plan.goal,
      tasks: result.plan.tasks.map((task) => ({
        ...task,
        dependsOn: [...task.dependsOn],
      })),
    },
    steps: result.steps.map((step) => ({
      task: {
        ...step.task,
        dependsOn: [...step.task.dependsOn],
      },
      result: step.result,
      output: step.output
        ? {
            ...step.output,
            artifacts: step.output.artifacts ? step.output.artifacts.map((artifact) => ({ ...artifact })) : undefined,
          }
        : undefined,
      evaluation: { ...step.evaluation },
    })),
    summary: { ...result.summary },
    completed: result.completed,
    status: derivePlanRunStatus(result, details.error),
    ...runContext,
    resultText: formatExecution(result, taskOutputs, mode),
    ...(details.error ? { error: details.error } : {}),
  };
  const completionDecision = judgePlanExecutionCompletion(result);
  const verificationPack = buildVerificationPack({
    planExecutionResult: result,
    planRunRecord: record,
    completionDecision,
  });
  const recoveryCheckpoint = mode === "goal" || mode === "autopilot"
    ? createRecoveryCheckpoint(record)
    : undefined;
  return {
    ...record,
    completionDecision,
    verificationPack,
    recoveryCheckpoint,
    resumeAdvice: recoveryCheckpoint ? buildResumeAdvice(recoveryCheckpoint, record) : undefined,
  };
}

async function runPlannedTask(
  goal: string,
  taskDescription: string,
  state: ReturnType<typeof createAppState>,
  systemPrompt: string,
  maxTurns: number,
  execution: PlanExecutionContext,
): Promise<{ success: boolean; finalText: string; message?: string }> {
  const previousOutputs = formatCompletedOutputsForPrompt(execution);
  const taskMessages = [
    {
      role: "user" as const,
      content: [
        "You are executing one step of a larger plan.",
        `Overall goal: ${goal}`,
        `Current task: ${taskDescription}`,
        previousOutputs ? `Completed task outputs:\n${previousOutputs}` : "",
        "Use tools if needed and finish with a concise result for this step.",
      ].join("\n"),
    },
  ];

  const loop = agentLoop({
    state,
    messages: taskMessages,
    systemPrompt,
    maxTurns,
    autoSummary: false,
  });

  let finalText = "";
  let failedMessage: string | undefined;

  for await (const event of loop) {
    switch (event.type) {
      case "text_delta":
        finalText += event.text;
        break;
      case "error":
        failedMessage = event.error.message;
        break;
      case "warning":
        break;
    }
  }

  if (failedMessage) {
    return {
      success: false,
      finalText,
      message: failedMessage,
    };
  }

  return {
    success: finalText.trim().length > 0,
    finalText,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureConfigDirs();

  if (opts.exportSession) {
    try {
      const sessionId = resolveSessionExportId(opts.exportSession);
      const format = parseSessionExportFormat(opts.exportFormat);
      process.stdout.write(renderSessionExport(sessionId, format));
      process.exit(0);
    } catch (err) {
      console.error(`[coreline-agent] ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // 1. Load config
  const settings = loadSettings();
  let budget: number | undefined;
  let watchdogTimeoutSeconds: number | undefined;
  try {
    budget = parseBudgetOption(opts.budget);
    watchdogTimeoutSeconds = parseWatchdogOption(opts.watchdogTimeout);
  } catch (err) {
    console.error(`[coreline-agent] ${(err as Error).message}`);
    process.exit(1);
  }
  let { configs, defaultName } = loadProviders();
  const { mode: permMode, rules: permRules } = loadPermissions();
  const hasConfiguredProviders = configs.length > 0;

  if (configs.length === 0) {
    const fallback = resolveFallbackProvider();
    if (fallback) {
      configs = [fallback];
      defaultName = fallback.name;
    }
  }

  if (hasConfiguredProviders) {
    defaultName = resolveDefaultProviderName({
      cliProvider: opts.provider,
      settingsDefaultProvider: settings.defaultProvider,
      providersDefaultName: defaultName,
    });
  } else if (opts.provider) {
    defaultName = opts.provider;
  }

  const maxTurns = resolveMaxTurns({
    cliMaxTurns: opts.maxTurns,
    settingsMaxTurns: settings.maxTurns,
  });

  if (configs.length === 0) {
    console.log("coreline-agent v" + VERSION);
    console.log("\nNo providers configured. Set up providers:\n");
    console.log("  1. Create ~/.coreline-agent/providers.yml:");
    console.log("     default: claude");
    console.log("     providers:");
    console.log("       claude:");
    console.log("         type: anthropic");
    console.log("         apiKey: ${ANTHROPIC_API_KEY}");
    console.log("         model: claude-sonnet-4-20250514\n");
    console.log("  2. Or set an env variable:");
    console.log("     export ANTHROPIC_API_KEY=sk-ant-...");
    console.log("     export OPENAI_API_KEY=sk-...");
    console.log("     export GOOGLE_API_KEY=...\n");
    process.exit(1);
  }

  const providerRegistry = new ProviderRegistryImpl(configs, defaultName);
  const activeProviderName = defaultName ?? configs[0]?.name;
  const activeProviderConfig = configs.find((config) => config.name === activeProviderName);

  if (!activeProviderConfig) {
    console.error(`[coreline-agent] Provider "${activeProviderName ?? "(unknown)"}" is not configured.`);
    process.exit(1);
  }

  const provider = instantiateProvider({
    ...activeProviderConfig,
    model: opts.model ?? activeProviderConfig.model,
  });

  if ((opts.planMode || opts.goalMode || opts.autopilot) && !provider.supportsPlanning) {
    console.error(
      `[coreline-agent] Provider "${provider.name}" (${provider.type}) does not support --plan-mode/--goal-mode/--autopilot yet.`,
    );
    process.exit(1);
  }

  let activeRole: Role | undefined;
  if (opts.role) {
    try {
      activeRole = loadRole(opts.role);
    } catch (err) {
      console.error(`[coreline-agent] Failed to load roles: ${(err as Error).message}`);
      process.exit(1);
    }

    if (!activeRole) {
      console.error(`[coreline-agent] Role not found: ${opts.role}`);
      process.exit(1);
    }
  }

  const statusTracker = new StatusTracker({
    initial: {
      status: "idle",
      mode: opts.autopilot ? "autopilot" : opts.goalMode ? "goal" : opts.planMode ? "plan" : "chat",
      provider: provider.name,
      model: provider.model,
      cwd: process.cwd(),
    },
  });
  statusTracker.write();

  runtimeLifecycle = createLifecycle({
    onSessionEnd: ({ reason }) => {
      statusTracker.close("exited", reason);
    },
  });

  const {
    tools: runtimeTools,
    mcpManager,
    mcpLoad,
    mcpStatus,
    mcpToolCount,
  } = await resolveRuntimeTools(Boolean(opts.verbose));
  const mcpUiState = summarizeMcpUiState(mcpLoad, mcpStatus, mcpToolCount);
  const { proxyStatus, proxyHandle } = await resolveProxyStatus(opts.proxy, providerRegistry, Boolean(opts.verbose), statusTracker);

  runtimeLifecycle.addCleanup(() => mcpManager?.close().catch(() => undefined), "mcp.close");
  runtimeLifecycle.addCleanup(() => {
    proxyHandle?.stop();
  }, "proxy.stop");

  process.on("SIGINT", () => {
    void runtimeLifecycle?.destroy("SIGINT");
  });
  process.on("SIGTERM", () => {
    void runtimeLifecycle?.destroy("SIGTERM");
  });
  process.on("beforeExit", () => {
    void runtimeLifecycle?.destroy("beforeExit");
  });
  process.on("uncaughtException", (error) => {
    console.error("[coreline-agent] uncaught exception:", error);
    process.exitCode = 1;
    void runtimeLifecycle?.destroy("uncaughtException", error);
  });

  if (opts.verbose) {
    console.error(`[coreline-agent] provider: ${provider.name} (${provider.model})`);
    console.error(`[coreline-agent] tools: ${runtimeTools.map((t) => t.name).join(", ")}`);
    console.error(`[coreline-agent] permission mode: ${permMode}`);
    if (activeRole) {
      console.error(`[coreline-agent] role: ${activeRole.name} (${activeRole.id})`);
    }
    if (opts.planMode) {
      console.error(`[coreline-agent] plan mode requested: provider capability = ${provider.supportsPlanning}`);
    }
    if (opts.goalMode) {
      console.error(`[coreline-agent] goal mode requested: provider capability = ${provider.supportsPlanning}`);
    }
    if (opts.autopilot) {
      console.error(`[coreline-agent] autopilot requested: provider capability = ${provider.supportsPlanning}`);
    }
  }

  // 2. Create state
  const projectMemory = new ProjectMemory(process.cwd());
  const rootSubAgentRuntime = createRootSubAgentRuntime(provider, runtimeTools, providerRegistry);
  const parallelAgentScheduler = new ParallelAgentScheduler({
    maxParallelAgentTasks: DEFAULT_MAX_PARALLEL_AGENT_TASKS,
  });
  runtimeLifecycle.addCleanup(() => {
    for (const task of parallelAgentScheduler.snapshot().tasks) {
      if (task.status === "running" || task.status === "pending") {
        parallelAgentScheduler.stop(task.id, "session");
      }
    }
  }, "parallel-agent.stop");
  const costTracker = new CostTracker(settings.pricing);
  const toolCache = new ToolCache();
  costTracker.setBudget(budget);
  const state = createAppState({
    cwd: process.cwd(),
    provider,
    tools: runtimeTools,
    permissionMode: permMode,
    permissionRules: permRules,
    projectMemory,
    subAgentRuntime: rootSubAgentRuntime,
    parallelAgentRegistry: parallelAgentScheduler.registry,
    parallelAgentScheduler,
    parallelAgentCapabilities: {
      supportsBackgroundTasks: false,
      maxParallelAgentTasks: DEFAULT_MAX_PARALLEL_AGENT_TASKS,
    },
    toolCache,
    costTracker,
    stopOnBudgetExceeded: Boolean(opts.budgetStop),
  });

  const systemPrompt = buildSystemPrompt(state.cwd, runtimeTools, projectMemory, state.provider, activeRole);

  // Register lifecycle digest listener: on normal termination, write MEMORY.md snapshot.
  try {
    runtimeLifecycle.onSessionEnd(createDigestListener({ projectMemory }));
  } catch {
    // Best-effort: digest listener registration must never block startup.
  }

  // I1 fix: register session-level hooks (skill evidence, session-recall
  // indexing, tier promotion tick). These were previously firing per-turn
  // in loop.ts; now they flush once at actual session end.
  try {
    runtimeLifecycle.onSessionEnd(() => {
      try {
        finalizeAllSessions();
      } catch {
        // best-effort
      }
    });
  } catch {
    // Best-effort: session-lifecycle registration must never block startup.
  }

  // 3. Session
  const resumeId = SessionManager.resolveResumeId(opts.resume);
  const session = new SessionManager({
    resumeSessionId: resumeId,
    providerName: provider.name,
    model: provider.model,
  });
  statusTracker.update({ sessionId: session.sessionId });
  state.sessionId = session.sessionId;
  state.agentId = "root";
  state.backupStore = new BackupStore({ sessionId: session.sessionId });
  await runtimeLifecycle?.beginSession({
    sessionId: session.sessionId,
    metadata: {
      mode: opts.autopilot ? "autopilot" : opts.goalMode ? "goal" : opts.planMode ? "plan" : "chat",
    },
  });
  state.saveSubAgentRun = (record) => session.saveSubAgentRun(record);

  if (opts.testLoop) {
    statusTracker.update("running", {
      mode: "chat",
      sessionId: session.sessionId,
      provider: provider.name,
      model: provider.model,
      message: "running test loop",
    });
    const command = typeof opts.testLoop === "string" && opts.testLoop.trim()
      ? opts.testLoop.trim()
      : undefined;
    const { events, result } = await runTestFixLoopToCompletion({
      cwd: state.cwd,
      ...(command ? { command } : {}),
      maxAttempts: 3,
      signal: state.abortController.signal,
    });
    if (opts.json) {
      console.log(JSON.stringify({ type: "test_loop_result", result, events }));
    } else {
      console.log(`Test loop ${result.passed ? "passed" : "stopped"}: ${result.stoppedReason}`);
      for (const event of events) {
        console.log(`- [${event.attempt}] ${event.message}`);
      }
    }
    statusTracker.update(result.passed ? "completed" : "failed", {
      mode: "chat",
      sessionId: session.sessionId,
      provider: provider.name,
      model: provider.model,
      message: result.stoppedReason,
    });
    await runtimeLifecycle?.destroy("manual");
    process.exit(result.passed ? 0 : 1);
  }

  // 4. Determine prompt (flag, positional, or stdin)
  const basePrompt = opts.prompt ?? (positionalPrompt || undefined);
  const stdinData = await readStdinIfPiped();
  const prompt = mergePromptAndStdin(basePrompt, stdinData);
  const resumableGoalRun = (opts.goalMode || opts.autopilot) && resumeId && !prompt
    ? session.loadLatestResumablePlanRun()
    : null;

  // ---------------------------------------------------------------------------
  // Non-interactive mode
  // ---------------------------------------------------------------------------
  if (prompt || resumableGoalRun) {
    const executionMode: PlanRunMode = opts.autopilot ? "autopilot" : opts.goalMode ? "goal" : "plan";
    const resolvedPrompt = prompt ?? resumableGoalRun?.prompt ?? resumableGoalRun?.goal ?? "";
    const preparedPrompt = prepareUserPrompt(resolvedPrompt, { cwd: state.cwd });
    const skillMode = opts.autopilot ? "autopilot" : opts.goalMode ? "goal" : opts.planMode ? "plan" : "one-shot";
    const activeSkillResult = selectBuiltInSkills({
      rawText: preparedPrompt.rawText,
      displayText: preparedPrompt.displayText,
      preparedText: preparedPrompt.messageText,
      expandedFileBodies: preparedPrompt.attachments.map((attachment) => attachment.content),
      explicitSkillIds: cliExplicitSkillIds,
      autoSkillsEnabled: shouldAutoSelectSkillsForMode(skillMode, opts.autoSkills !== false),
      mode: skillMode,
      isRootAgent: true,
    });
    const activeSystemPrompt = buildSystemPrompt(
      state.cwd,
      runtimeTools,
      projectMemory,
      state.provider,
      activeRole,
      { activeSkills: activeSkillResult.selections, hardeningHints: state.hardeningHints },
    );
    const attachmentIssueText = formatAtFileIssues(preparedPrompt.issues);

    if (attachmentIssueText) {
      console.error(attachmentIssueText);
    }

    if (!preparedPrompt.messageText.trim()) {
      console.error("[coreline-agent] No prompt content remained after resolving @file attachments.");
      process.exit(1);
    }

    const initialMessages = resumeId ? session.loadMessages() : [];
    if (!resumableGoalRun) {
      const userMsg = { role: "user" as const, content: preparedPrompt.messageText };
      initialMessages.push(userMsg);
      session.saveMessage(userMsg);
    }

    if (opts.planMode || opts.goalMode || opts.autopilot) {
      statusTracker.update("planning", {
        mode: executionMode,
        sessionId: session.sessionId,
        provider: provider.name,
        model: provider.model,
        message: "building plan",
      });
      const plan = resumableGoalRun
        ? {
            goal: resumableGoalRun.plan.goal,
            tasks: resumableGoalRun.plan.tasks.map((task) => clonePlanTask(task)),
          }
        : await buildPlan(preparedPrompt.messageText, state);

      let runningPlanRun: PlanRunRecord = resumableGoalRun
        ? {
            ...clonePlanRecord(resumableGoalRun),
            createdAt: new Date().toISOString(),
            prompt: preparedPrompt.messageText,
            goal: preparedPrompt.messageText,
            status: "running",
            error: undefined,
            completed: false,
            resumeEligible: true,
          }
        : {
            _type: "plan_run",
            planRunId: randomUUID(),
            sessionId: session.sessionId,
            createdAt: new Date().toISOString(),
            mode: executionMode,
            source: "cli",
            cwd: state.cwd,
            providerName: provider.name,
            model: provider.model,
            prompt: preparedPrompt.messageText,
            goal: plan.goal,
            activeTaskId: plan.tasks[0]?.id,
            nextAction: plan.tasks[0]?.id ? "start" : undefined,
            recoveryAction: undefined,
            resumeEligible: executionMode === "goal" || executionMode === "autopilot",
            plan: {
              goal: plan.goal,
              tasks: plan.tasks.map((task) => clonePlanTask(task)),
            },
            steps: [],
            summary: { completed: 0, failed: 0, ambiguous: 0, verified: 0 },
            completed: false,
            status: "running",
          };

      if (executionMode === "goal" || executionMode === "autopilot") {
        session.savePlanRun(runningPlanRun);
      }

      const executionOptions = {
        runTask: async (task: Task, planState: typeof state, execution: PlanExecutionContext) =>
          await runPlannedTask(
            preparedPrompt.messageText,
            task.description,
            planState,
            activeSystemPrompt,
            maxTurns,
            execution,
          ),
        onTaskStart: (task: Task) => {
          statusTracker.update("running", {
            mode: executionMode,
            sessionId: session.sessionId,
            provider: provider.name,
            model: provider.model,
            message: task.description,
          });
          if (executionMode === "plan") return;
          runningPlanRun = updateStoredPlanRunStep(runningPlanRun, task.id, {
            taskStatus: "running",
            activeTaskId: task.id,
            nextAction: "run",
            status: "running",
            completed: false,
            resumeEligible: true,
          });
          session.savePlanRun(runningPlanRun);
        },
        onTaskEnd: (step: PlanExecutionStep) => {
          if (executionMode === "plan") return;
          runningPlanRun = updateStoredPlanRunStep(runningPlanRun, step.task.id, {
            taskStatus: step.task.status,
            result: step.result,
            output: step.output,
            evaluation: step.evaluation,
            activeTaskId: findNextActiveTaskId(runningPlanRun),
            nextAction: step.task.nextAction,
            recoveryAction: step.task.recovery?.action,
            status: step.task.status === "needs_user"
              ? "needs_user"
              : step.task.status === "blocked"
                ? "blocked"
                : runningPlanRun.status,
            resumeEligible: true,
            lastVerificationSummary: step.task.verification?.summary ?? step.output?.verificationSummary ?? step.output?.summary,
            lastFailureClass: step.task.status === "blocked" || step.task.status === "needs_user" || step.task.status === "failed" || step.task.status === "aborted"
              ? step.task.status
              : undefined,
            lastFailureReason: step.task.failureReason ?? step.task.recovery?.lastFailureReason ?? step.task.recovery?.reason ?? step.evaluation.reason,
            lastRecoveryRationale: step.task.recovery?.reason ?? step.task.nextAction,
          });
          runningPlanRun.activeTaskId = findNextActiveTaskId(runningPlanRun);
          session.savePlanRun(runningPlanRun);
        },
      };

      const result = executionMode === "autopilot"
        ? await runAutopilot(preparedPrompt.messageText, state, {
            ...executionOptions,
            planner: {
              async plan(goalText, autopilotState) {
                if (goalText === preparedPrompt.messageText && !resumableGoalRun && runningPlanRun.steps.length === 0) {
                  return {
                    goal: plan.goal,
                    tasks: plan.tasks.map((task) => clonePlanTask(task)),
                  };
                }
                return buildPlan(goalText, autopilotState);
              },
            },
            resumeState: resumableGoalRun && resumableGoalRun.mode === "autopilot"
              ? {
                  plan: {
                    goal: resumableGoalRun.plan.goal,
                    tasks: resumableGoalRun.plan.tasks.map((task) => clonePlanTask(task)),
                  },
                  cycleCount: resumableGoalRun.cycleCount,
                  decisionLog: resumableGoalRun.decisionLog,
                }
              : undefined,
            onCycleStart: ({ cycle }) => {
              runningPlanRun.cycleCount = cycle;
              runningPlanRun.status = "running";
              runningPlanRun.nextAction = "autopilot-cycle";
              session.savePlanRun(runningPlanRun);
            },
            onDecision: ({ decision }) => {
              runningPlanRun.decisionLog = [...(runningPlanRun.decisionLog ?? []), { ...decision }];
              runningPlanRun.cycleCount = Math.max(runningPlanRun.cycleCount ?? 0, decision.cycle);
              if (decision.kind === "stop") {
                runningPlanRun.stopReason = decision.reason;
              }
              session.savePlanRun(runningPlanRun);
            },
          })
        : await executePlan(plan, state, executionOptions);

      const executionResult: PlanExecutionResult = executionMode === "autopilot"
        ? (result as AutopilotRunResult).result
        : result as PlanExecutionResult;
      const autopilotResult = executionMode === "autopilot"
        ? result as AutopilotRunResult
        : null;

      const taskOutputs = new Map<string, string>();
      for (const step of executionResult.steps) {
        const text = step.output?.summary?.trim()
          ?? step.output?.finalText?.trim()
          ?? "";
        taskOutputs.set(step.task.id, text);
      }

      const planSummary = formatExecution(executionResult, taskOutputs, executionMode);
      const storedRun = createStoredPlanRunRecord(session.sessionId, executionResult, taskOutputs, {
        prompt: preparedPrompt.messageText,
        providerName: provider.name,
        model: provider.model,
        cwd: state.cwd,
        source: "cli",
        mode: executionMode,
        planRunId: executionMode === "goal" || executionMode === "autopilot" ? runningPlanRun.planRunId : undefined,
        cycleCount: autopilotResult?.cycleCount,
        decisionLog: autopilotResult?.decisionLog,
        stopReason: autopilotResult?.stopReason,
      });
      if (executionMode === "goal" || executionMode === "autopilot") {
        storedRun.planRunId = runningPlanRun.planRunId;
        storedRun.activeTaskId = autopilotResult?.activeTaskId ?? findNextActiveTaskId(storedRun);
        storedRun.nextAction = storedRun.completed ? "stop" : runningPlanRun.nextAction;
        storedRun.recoveryAction = runningPlanRun.recoveryAction;
        storedRun.resumeEligible = !storedRun.completed;
      }
      session.savePlanRun(storedRun);
      statusTracker.update(
        storedRun.status === "blocked"
          ? "blocked"
          : storedRun.status === "needs_user"
            ? "needs_user"
            : executionResult.completed
              ? "completed"
              : "failed",
        {
          mode: executionMode,
          sessionId: session.sessionId,
          provider: provider.name,
          model: provider.model,
          message: autopilotResult?.stopReason ?? storedRun.error ?? planSummary.split("\n")[0],
          resumeEligible: storedRun.resumeEligible,
        },
      );
      const assistantMsg = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: planSummary }],
      };
      session.saveMessage(assistantMsg);

      if (opts.json) {
        console.log(
          JSON.stringify({
            type: executionMode === "autopilot" ? "autopilot_result" : executionMode === "goal" ? "goal_result" : "plan_result",
            plan: executionResult.plan,
            summary: executionResult.summary,
            completed: executionResult.completed,
            stopStatus: autopilotResult?.stopStatus,
            stopReason: autopilotResult?.stopReason,
            cycleCount: autopilotResult?.cycleCount,
            outputs: Object.fromEntries(taskOutputs),
          }),
        );
      } else {
        console.log(planSummary);
      }

      await runtimeLifecycle?.destroy("manual");
      process.exit(executionResult.completed ? 0 : 1);
    }

    statusTracker.update("running", {
      mode: "chat",
      sessionId: session.sessionId,
      provider: provider.name,
      model: provider.model,
      message: "running one-shot prompt",
    });

    const watchdog = watchdogTimeoutSeconds
      ? new ProgressWatchdog({
          timeoutSeconds: watchdogTimeoutSeconds,
          onTimeout: (snapshot) => {
            const message = `Watchdog timeout: no progress for ${snapshot.timeoutSeconds}s${snapshot.lastLabel ? ` after ${snapshot.lastLabel}` : ""}`;
            if (opts.json) {
              console.log(JSON.stringify({
                type: "watchdog_timeout",
                timeoutSeconds: snapshot.timeoutSeconds,
                elapsedMs: snapshot.elapsedMs ?? 0,
                lastLabel: snapshot.lastLabel,
                message,
              }));
            } else {
              console.error(`\n[watchdog] ${message}`);
            }
            statusTracker.update("aborted", {
              mode: "chat",
              sessionId: session.sessionId,
              provider: provider.name,
              model: provider.model,
              message,
            });
            state.abortController.abort();
          },
        })
      : undefined;
    watchdog?.start();

    const loop = agentLoop({
      state,
      messages: initialMessages,
      systemPrompt: activeSystemPrompt,
      maxTurns,
      autoSummary: opts.autoSummary !== false,
      onMessage: (message) => session.saveMessage(message),
    });

    let fullText = "";
    let result = await loop.next();
    while (!result.done) {
      const event = result.value;
      watchdog?.touch(event.type);

      if (opts.json) {
        console.log(JSON.stringify(event));
      } else {
        switch (event.type) {
          case "text_delta":
            fullText += event.text;
            process.stdout.write(event.text);
            break;
          case "reasoning_delta":
            if (showReasoning) {
              // Write to stderr in dim/italic so pipes don't get reasoning
              process.stderr.write(`\x1b[2;3m${event.text}\x1b[0m`);
            }
            break;
          case "tool_start":
            if (opts.verbose) console.error(`\n[tool] ${event.toolName}: ${JSON.stringify(event.input).slice(0, 100)}`);
            break;
          case "tool_end":
            if (opts.verbose) console.error(`[tool] ${event.toolName}: ${event.isError ? "ERROR" : "OK"}`);
            break;
          case "loop_detected":
            if (opts.verbose) {
              console.error(
                `[loop] ${event.toolName} repeated ${event.consecutiveCount}x ` +
                `(hash=${event.inputHash}, threshold=${event.threshold})`,
              );
            }
            break;
          case "error":
            console.error(`\n[error] ${event.error.message}`);
            break;
          case "warning":
            console.error(`\n[warning] ${event.message}`);
            break;
          case "turn_end":
            if (!opts.json) console.log();
            break;
        }
      }
      result = await loop.next();
    }
    const timedOut = watchdog?.getSnapshot().timedOut ?? false;
    watchdog?.stop();
    statusTracker.update(timedOut ? "aborted" : "completed", {
      mode: "chat",
      sessionId: session.sessionId,
      message: timedOut ? "watchdog timeout" : "prompt completed",
    });
    await runtimeLifecycle?.destroy("manual");
    process.exit(timedOut ? 1 : 0);
  }

  if ((opts.goalMode || opts.autopilot) && resumeId) {
    console.error(`[coreline-agent] No resumable ${opts.autopilot ? "autopilot" : "goal"} run was found for this session.`);
    await runtimeLifecycle?.destroy("manual");
    process.exit(1);
  }

  if (opts.planMode || opts.goalMode || opts.autopilot) {
    console.error(`[coreline-agent] ${opts.autopilot ? "--autopilot" : opts.goalMode ? "--goal-mode" : "--plan-mode"} currently requires -p/--prompt.`);
    await runtimeLifecycle?.destroy("manual");
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Interactive TUI mode
  // ---------------------------------------------------------------------------
  if (resumeId && opts.verbose) {
    console.error(`[coreline-agent] resuming session: ${session.sessionId}`);
  }

  state.parallelAgentCapabilities = {
    supportsBackgroundTasks: true,
    maxParallelAgentTasks: DEFAULT_MAX_PARALLEL_AGENT_TASKS,
  };

  launchTUI({
    state,
    providerRegistry,
    systemPrompt,
    maxTurns,
    session,
    showReasoning,
    mcpStatus: mcpUiState,
    proxyStatus,
    statusTracker,
    activeRole,
    initialExplicitSkillIds: cliExplicitSkillIds,
    initialAutoSkillsEnabled: opts.autoSkills !== false,
  });
}

main().catch(async (err) => {
  console.error("[coreline-agent] fatal:", err);
  await runtimeLifecycle?.destroy("uncaughtException", err);
  process.exit(1);
});
