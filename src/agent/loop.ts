/**
 * Core Agent Loop — the heart of coreline-agent.
 *
 * Pattern: async generator that yields AgentEvents.
 *   while (true) {
 *     1. Send messages + tools to LLM provider
 *     2. Stream text deltas → yield TextDeltaEvent
 *     3. Collect tool calls from stream
 *     4. If tool calls: check permissions → execute → yield events → append results → continue
 *     5. If no tool calls: yield TurnEndEvent → return
 *   }
 *
 * Reference: Claude Code query.ts queryLoop() pattern.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ChatMessage,
  AssistantMessage,
  UserMessage,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  Usage,
  TurnEndReason,
} from "./types.js";
import type { AppState } from "./context.js";
import { toToolUseContext } from "./context.js";
import type { ChatChunk, ToolDefinition } from "../providers/types.js";
import { toolToDefinition, type Tool } from "../tools/types.js";
import { runToolCalls } from "../tools/orchestration.js";
import { storeToolResultSync } from "../tools/result-storage.js";
import { withRetry } from "./retry.js";
import { compactMessages, truncateToolOutput } from "./context-manager.js";
import { estimateTokens } from "../utils/token-estimator.js";
import { ToolCallDedup, hashInput } from "./tool-call-dedup.js";
import { ToolCallPatternGuard } from "./tool-loop-guard.js";
import { maybeWriteAutoSummary } from "../memory/index.js";
import { trackSessionTurn } from "./self-improve/session-lifecycle-hooks.js";
import {
  checkEscalationThreshold,
  escalateToolFailure,
  recordToolFailure,
} from "./incident/incident-escalation.js";
import type { HardeningFailureKind } from "./hardening-types.js";
import { getSnipTurnIndex, hashChatMessage, type SnipRegistry } from "./context-snip.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 50;
const MAX_TOOL_CALL_DUPLICATES = 3;
const MAX_HARDENING_HINTS = 3;
const STORED_TOOL_OUTPUT_PREVIEW_CHARS = 4_000;

function markSnipRange(
  registry: SnipRegistry | undefined,
  messages: readonly ChatMessage[],
  range: { startIndex: number; endIndex: number; reason: string; priority: number },
): void {
  if (!registry) return;
  const start = messages[range.startIndex];
  const end = messages[range.endIndex];
  if (!start || !end || range.startIndex > range.endIndex) return;

  try {
    registry.add({
      id: randomUUID(),
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      startTurn: getSnipTurnIndex(messages, range.startIndex),
      endTurn: getSnipTurnIndex(messages, range.endIndex),
      startContentHash: hashChatMessage(start),
      endContentHash: hashChatMessage(end),
      createdAt: new Date().toISOString(),
      reason: range.reason,
      priority: range.priority,
    });
  } catch {
    // Snip markers are best-effort and must never affect core agent execution.
  }
}

function recordHardeningHint(
  state: AppState,
  kind: HardeningFailureKind,
  message: string,
  source?: string,
): void {
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (!trimmed) return;
  state.hardeningHints = [
    ...state.hardeningHints,
    {
      kind,
      message: trimmed.slice(0, 240),
      source,
      createdAt: new Date().toISOString(),
    },
  ].slice(-MAX_HARDENING_HINTS);
}

// ---------------------------------------------------------------------------
// Collected Response (result of streaming one LLM turn)
// ---------------------------------------------------------------------------

interface CollectedResponse {
  textParts: string[];
  toolCalls: Array<{ id: string; name: string; inputJson: string }>;
  usage: Usage;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
}

interface ParsedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  parseError?: Error;
}

// ---------------------------------------------------------------------------
// Stream driver — async generator that yields TextDeltaEvents AND returns
// the full CollectedResponse. Caller uses `yield*` to forward events.
// ---------------------------------------------------------------------------

async function* driveStream(
  stream: AsyncIterable<ChatChunk>,
): AsyncGenerator<AgentEvent, CollectedResponse> {
  const textParts: string[] = [];
  const activeToolCalls = new Map<string, { id: string; name: string; inputJson: string }>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let stopReason: CollectedResponse["stopReason"] = "end_turn";

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta":
        textParts.push(chunk.text);
        yield { type: "text_delta", text: chunk.text };
        break;

      case "reasoning_delta":
        yield { type: "reasoning_delta", text: chunk.text };
        break;

      case "tool_call_start":
        activeToolCalls.set(chunk.toolCall.id, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          inputJson: "",
        });
        break;

      case "tool_call_delta": {
        const tc = activeToolCalls.get(chunk.toolCallId);
        if (tc) {
          tc.inputJson += chunk.inputDelta;
        }
        break;
      }

      case "tool_call_end":
        break;

      case "done":
        usage = chunk.usage;
        stopReason = chunk.stopReason;
        break;
    }
  }

  return {
    textParts,
    toolCalls: [...activeToolCalls.values()],
    usage,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Build messages for next turn
// ---------------------------------------------------------------------------

function parseToolCallInput(tc: CollectedResponse["toolCalls"][number]): ParsedToolCall {
  if (!tc.inputJson) {
    return {
      id: tc.id,
      name: tc.name,
      input: {},
    };
  }

  try {
    const parsed = JSON.parse(tc.inputJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        id: tc.id,
        name: tc.name,
        input: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Fall through to structured error + empty-object fallback below.
  }

  return {
    id: tc.id,
    name: tc.name,
    input: {},
    parseError: new Error(
      `Malformed tool input JSON for ${tc.name}; falling back to {}: ${tc.inputJson.slice(0, 100)}`,
    ),
  };
}

function buildAssistantMessage(textParts: string[], toolCalls: ParsedToolCall[]): AssistantMessage {
  const content: ContentBlock[] = [];

  const fullText = textParts.join("");
  if (fullText) {
    content.push({ type: "text", text: fullText } satisfies TextBlock);
  }

  for (const tc of toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    } satisfies ToolUseBlock);
  }

  return { role: "assistant", content };
}

function buildToolResultMessage(
  results: Array<{ toolUseId: string; content: string; isError: boolean }>,
): UserMessage {
  const content: ContentBlock[] = results.map((r) => ({
    type: "tool_result" as const,
    toolUseId: r.toolUseId,
    content: r.content,
    isError: r.isError || undefined,
  }));
  return { role: "user", content };
}

function resolveToolResultMaxChars(tool: Tool, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.min(tool.maxResultSizeChars, override);
  }
  return tool.maxResultSizeChars;
}

function prepareToolResultForContext(
  args: {
    state: AppState;
    tool: Tool;
    toolUseId: string;
    toolName: string;
    formattedResult: string;
    maxResultChars?: number;
  },
): string {
  const maxChars = resolveToolResultMaxChars(args.tool, args.maxResultChars);
  if (args.formattedResult.length <= maxChars) {
    return args.formattedResult;
  }

  try {
    const stored = storeToolResultSync(
      {
        toolUseId: args.toolUseId,
        toolName: args.toolName,
        content: args.formattedResult,
        kind: "text",
      },
      {
        cwd: args.state.cwd,
        sessionId: args.state.sessionId,
        previewChars: Math.min(STORED_TOOL_OUTPUT_PREVIEW_CHARS, Math.max(0, maxChars)),
      },
    );
    return stored.previewMessage.length > maxChars
      ? truncateToolOutput(stored.previewMessage, maxChars)
      : stored.previewMessage;
  } catch {
    return truncateToolOutput(args.formattedResult, maxChars);
  }
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  state: AppState;
  messages: ChatMessage[];
  systemPrompt: string;
  maxTurns?: number;
  /** Optional per-run provider temperature override. Applied to the next provider request. */
  temperature?: number;
  /** Optional global tool result truncation override. Cannot raise per-tool max limits. */
  maxResultChars?: number;
  autoSummary?: boolean;
  snipRegistry?: SnipRegistry;
  onMessage?: (message: ChatMessage) => void;
}

export async function* agentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent, { reason: TurnEndReason }> {
  const { state, systemPrompt } = options;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages = [...options.messages];
  let turnCount = 0;
  const toolCallDedup = new ToolCallDedup();
  const toolLoopGuard = new ToolCallPatternGuard();

  // Prepare tool definitions once
  const toolDefs: ToolDefinition[] = [];
  for (const tool of state.tools.values()) {
    toolDefs.push(await toolToDefinition(tool));
  }

  const systemPromptTokens = estimateTokens(systemPrompt);
  const contextBudget = {
    maxTokens: state.provider.maxContextTokens,
    reservedForResponse: 8192,
  };

  // ---- Main Loop ----
  while (turnCount < maxTurns) {
    turnCount++;

    if (state.abortController.signal.aborted) {
      yield { type: "turn_end", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      return { reason: "aborted" };
    }

    // 0. Context compaction (trim old messages if near window limit)
    const compactResult = compactMessages(messages, systemPromptTokens, contextBudget, {
      snipMarkers: options.snipRegistry,
    });
    if (compactResult.compacted) {
      messages.length = 0;
      messages.push(...compactResult.messages);
    }

    // 1. Call LLM provider with retry on failure
    let collected: CollectedResponse;
    try {
      const stream = state.provider.send({
        messages,
        systemPrompt,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        temperature: options.temperature,
        signal: state.abortController.signal,
      });

      collected = yield* driveStream(stream);

    } catch (err) {
      if (state.abortController.signal.aborted) {
        return { reason: "aborted" };
      }

      // Retry on retryable errors
      try {
        const retryStream = await withRetry(
          async () => {
            const s = state.provider.send({
              messages,
              systemPrompt,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              temperature: options.temperature,
              signal: state.abortController.signal,
            });
            // Validate stream starts correctly by consuming first chunk
            return s;
          },
          { maxRetries: 2 },
        );
        collected = yield* driveStream(retryStream);
      } catch (retryErr) {
        yield { type: "error", error: retryErr as Error };
        yield { type: "turn_end", reason: "error", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        return { reason: "error" };
      }
    }

    // Track usage
    state.totalUsage.inputTokens += collected.usage.inputTokens;
    state.totalUsage.outputTokens += collected.usage.outputTokens;
    const costSnapshot = state.costTracker?.addUsage(state.provider.model, collected.usage);
    if (costSnapshot?.overBudget) {
      yield {
        type: "warning",
        code: "budget_exceeded",
        message: `Budget exceeded: ${state.costTracker?.formatCost(costSnapshot.totalCost) ?? `$${costSnapshot.totalCost.toFixed(2)}`}`,
      };
      if (state.stopOnBudgetExceeded) {
        yield { type: "turn_end", reason: "aborted", usage: collected.usage };
        return { reason: "aborted" };
      }
    }

    // 2. Build assistant message
    const parsedToolCalls = collected.toolCalls.map(parseToolCallInput);
    const assistantMsg = buildAssistantMessage(collected.textParts, parsedToolCalls);
    messages.push(assistantMsg);
    options.onMessage?.(assistantMsg);

    for (const tc of parsedToolCalls) {
      if (tc.parseError) {
        yield { type: "error", error: tc.parseError };
      }
    }

    // 3. No tool calls → done
    if (parsedToolCalls.length === 0) {
      markSnipRange(options.snipRegistry, messages, {
        startIndex: Math.max(0, messages.length - 2),
        endIndex: messages.length - 1,
        reason: "completed turn",
        priority: 10,
      });

      try {
        maybeWriteAutoSummary({
          projectMemory: state.projectMemory,
          messages,
          systemPrompt,
          agentDepth: state.agentDepth,
          enabled: options.autoSummary,
        });
      } catch {
        // Auto-summary is best-effort and must never break a completed turn.
      }

      // I1 fix: accumulate session state per-turn; actual session-end hooks
      // (evaluateSessionSkills, indexSession, sessionTickAndMaybePromote) fire
      // once per session via `finalizeAllSessions()` registered on
      // `runtimeLifecycle.onSessionEnd()` in `src/index.ts`.
      try {
        trackSessionTurn({
          sessionId: state.sessionId,
          projectMemory: state.projectMemory,
          messages,
        });
      } catch {
        // Session tracking is best-effort; never break a completed turn.
      }

      yield { type: "turn_end", reason: "completed", usage: collected.usage };
      return { reason: "completed" };
    }

    // 4. Execute tool calls
    const toolUseBlocks: ToolUseBlock[] = parsedToolCalls.map((tc) => ({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));

    const toolResults: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
    const approvedBlocks: ToolUseBlock[] = [];

    for (const block of toolUseBlocks) {
      const patternResult = toolLoopGuard.record(block.name);
      if (patternResult.triggered) {
        yield {
          type: "loop_detected",
          toolName: block.name,
          inputHash: patternResult.inputHash,
          consecutiveCount: patternResult.consecutiveCount,
          threshold: patternResult.threshold,
          message: patternResult.message ?? "Detected a repeating tool pattern.",
        };
        yield { type: "tool_start", toolUseId: block.id, toolName: block.name, input: block.input };
        yield {
          type: "tool_end",
          toolUseId: block.id,
          toolName: block.name,
          result: patternResult.message ?? "Detected a repeating tool pattern.",
          isError: true,
        };
        toolResults.push({
          toolUseId: block.id,
          content: patternResult.message ?? "Detected a repeating tool pattern.",
          isError: true,
        });
        continue;
      }

      const inputHash = hashInput(block.input);
      const dedupResult = toolCallDedup.record(block.name, inputHash);
      const duplicateMessage =
        `You've already tried this exact tool call ${MAX_TOOL_CALL_DUPLICATES} times ` +
        `(${block.name} ${inputHash}). Try a different approach.`;

      if (dedupResult.consecutiveCount === MAX_TOOL_CALL_DUPLICATES) {
        yield {
          type: "loop_detected",
          toolName: block.name,
          inputHash,
          consecutiveCount: dedupResult.consecutiveCount,
          threshold: MAX_TOOL_CALL_DUPLICATES,
          message: duplicateMessage,
        };
      }

      if (dedupResult.consecutiveCount > MAX_TOOL_CALL_DUPLICATES) {
        yield {
          type: "loop_detected",
          toolName: block.name,
          inputHash,
          consecutiveCount: dedupResult.consecutiveCount,
          threshold: MAX_TOOL_CALL_DUPLICATES,
          message: duplicateMessage,
        };
        yield { type: "tool_start", toolUseId: block.id, toolName: block.name, input: block.input };
        yield {
          type: "tool_end",
          toolUseId: block.id,
          toolName: block.name,
          result: duplicateMessage,
          isError: true,
        };
        toolResults.push({
          toolUseId: block.id,
          content: duplicateMessage,
          isError: true,
        });
        continue;
      }

      // Permission check BEFORE execution
      const permResult = state.permissionEngine.check(
        block.name,
        block.input,
        state.permissionContext,
      );

      if (permResult.behavior === "deny") {
        const denyMsg = `Permission denied: ${permResult.reason ?? "denied by rule"}`;
        recordHardeningHint(state, "permission_denied", denyMsg, block.name);
        yield { type: "tool_start", toolUseId: block.id, toolName: block.name, input: block.input };
        yield { type: "tool_end", toolUseId: block.id, toolName: block.name, result: denyMsg, isError: true };
        toolResults.push({ toolUseId: block.id, content: denyMsg, isError: true });
        continue;
      }

      // "ask" behavior → interactive parent prompts the user, non-interactive child auto-denies
      if (permResult.behavior === "ask") {
        if (state.nonInteractive) {
          const denyMsg = `Permission denied in non-interactive mode for ${block.name}`;
          recordHardeningHint(state, "permission_denied", denyMsg, block.name);
          yield { type: "tool_start", toolUseId: block.id, toolName: block.name, input: block.input };
          yield { type: "tool_end", toolUseId: block.id, toolName: block.name, result: denyMsg, isError: true };
          toolResults.push({ toolUseId: block.id, content: denyMsg, isError: true });
          continue;
        }

        let resolveFn: (allowed: boolean) => void = () => {};
        const userResponse = new Promise<boolean>((resolve) => { resolveFn = resolve; });

        yield {
          type: "permission_ask",
          toolUseId: block.id,
          toolName: block.name,
          input: block.input,
          resolve: (allowed: boolean) => resolveFn(allowed),
        };

        // Auto-deny after 5 minutes if no response (safety net)
        const timeoutId = setTimeout(() => resolveFn(false), 5 * 60 * 1000);
        const allowed = await userResponse;
        clearTimeout(timeoutId);

        if (!allowed) {
          const denyMsg = `User denied permission for ${block.name}`;
          recordHardeningHint(state, "permission_denied", denyMsg, block.name);
          yield { type: "tool_start", toolUseId: block.id, toolName: block.name, input: block.input };
          yield { type: "tool_end", toolUseId: block.id, toolName: block.name, result: denyMsg, isError: true };
          toolResults.push({ toolUseId: block.id, content: denyMsg, isError: true });
          continue;
        }
      }
      // Permission approved. PreTool hooks run later in runToolCalls() after input schema validation and before tool.call().
      approvedBlocks.push(block);
    }

    if (approvedBlocks.length > 0) {
      for (const block of approvedBlocks) {
        yield { type: "tool_start", toolUseId: block.id, toolName: block.name, input: block.input };
      }

      for await (const result of runToolCalls(approvedBlocks, state.tools, toToolUseContext(state))) {
        const tool = state.tools.get(result.toolName);
        const formatted = tool
          ? prepareToolResultForContext({
              state,
              tool,
              toolUseId: result.toolUseId,
              toolName: result.toolName,
              formattedResult: result.formattedResult,
              maxResultChars: options.maxResultChars,
            })
          : result.formattedResult;

        yield {
          type: "tool_end",
          toolUseId: result.toolUseId,
          toolName: result.toolName,
          result: formatted,
          isError: result.result.isError ?? false,
        };
        toolResults.push({
          toolUseId: result.toolUseId,
          content: formatted,
          isError: result.result.isError ?? false,
        });
        if (result.result.isError) {
          recordHardeningHint(
            state,
            formatted.toLowerCase().includes("hook") ? "hook_blocked" : "tool_error",
            formatted,
            result.toolName,
          );
          try {
            const sessionId = state.sessionId ?? "";
            const projectId = state.projectMemory?.projectId ?? "";
            if (sessionId && projectId) {
              recordToolFailure(sessionId, result.toolName, String(formatted ?? "unknown"));
              if (checkEscalationThreshold(sessionId, result.toolName)) {
                escalateToolFailure(projectId, sessionId, result.toolName);
              }
            }
          } catch {
            // best-effort
          }
        }
      }
    }

    // 5. Append tool results and continue loop
    if (toolResults.length > 0) {
      const toolResultMsg = buildToolResultMessage(toolResults);
      const toolResultIndex = messages.length;
      messages.push(toolResultMsg);
      options.onMessage?.(toolResultMsg);
      markSnipRange(options.snipRegistry, messages, {
        startIndex: Math.max(0, toolResultIndex - 1),
        endIndex: toolResultIndex,
        reason: "completed tool result",
        priority: 30,
      });
    }
  }

  // Max turns reached
  const totalUsage = {
    inputTokens: state.totalUsage.inputTokens,
    outputTokens: state.totalUsage.outputTokens,
    totalTokens: state.totalUsage.inputTokens + state.totalUsage.outputTokens,
  };
  yield { type: "turn_end", reason: "max_turns", usage: totalUsage };
  return { reason: "max_turns" };
}
