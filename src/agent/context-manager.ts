/**
 * Context Manager — manages conversation context window.
 *
 * Handles:
 * 1. Token budget tracking
 * 2. Tool output truncation (maxResultSizeChars)
 * 3. Context compaction (summarize old messages when window is full)
 */

import type { ChatMessage, ContentBlock } from "./types.js";
import { estimateMessageTokens, estimateTotalTokens, estimateTokens } from "../utils/token-estimator.js";
import { applySnips, type SnipMarker, type SnipPolicy, type SnipRegistry } from "./context-snip.js";

// ---------------------------------------------------------------------------
// Output Truncation
// ---------------------------------------------------------------------------

const TRUNCATION_SUFFIX = "\n\n[Output truncated. Use offset/limit to read specific sections.]";

export function truncateToolOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  if (maxChars <= TRUNCATION_SUFFIX.length) {
    return content.slice(0, Math.max(0, maxChars));
  }
  return content.slice(0, maxChars - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

// ---------------------------------------------------------------------------
// Context Window Management
// ---------------------------------------------------------------------------

export interface ContextBudget {
  maxTokens: number;
  reservedForResponse: number; // tokens reserved for LLM response
}

const DEFAULT_BUDGET: ContextBudget = {
  maxTokens: 128_000,
  reservedForResponse: 8_192,
};

/**
 * Trim messages to fit within the context window.
 * Strategy: keep system prompt + last N messages that fit.
 * Oldest user/assistant pairs are dropped first.
 */
export function trimToContextWindow(
  messages: ChatMessage[],
  systemPromptTokens: number,
  budget: ContextBudget = DEFAULT_BUDGET,
): ChatMessage[] {
  const available = budget.maxTokens - budget.reservedForResponse - systemPromptTokens;
  if (available <= 0) return messages.slice(-2); // keep at minimum last exchange

  // Calculate tokens from the end
  const result: ChatMessage[] = [];
  let totalTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i]!);
    if (totalTokens + msgTokens > available) break;
    totalTokens += msgTokens;
    result.unshift(messages[i]!);
  }

  // Always include at least the last message
  if (result.length === 0 && messages.length > 0) {
    result.push(messages[messages.length - 1]!);
  }

  return result;
}

/**
 * Compact context: summarize dropped messages into a single system message.
 */
export function compactMessages(
  messages: ChatMessage[],
  systemPromptTokens: number,
  budget: ContextBudget = DEFAULT_BUDGET,
  options: {
    snipMarkers?: readonly SnipMarker[] | SnipRegistry;
    snipPolicy?: SnipPolicy;
  } = {},
): { messages: ChatMessage[]; compacted: boolean; droppedCount: number } {
  const available = budget.maxTokens - budget.reservedForResponse - systemPromptTokens;
  const currentTokens = estimateTotalTokens(messages);

  if (currentTokens <= available) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  if (options.snipMarkers) {
    const snipResult = applySnips(
      messages,
      options.snipMarkers,
      {
        maxTokens: budget.maxTokens,
        reservedForResponse: budget.reservedForResponse,
        systemPromptTokens,
      },
      options.snipPolicy,
    );

    if (snipResult.compacted) {
      return {
        messages: snipResult.messages,
        compacted: true,
        droppedCount: snipResult.droppedCount,
      };
    }
  }

  // Find how many messages to keep from the end
  const kept = trimToContextWindow(messages, systemPromptTokens, budget);
  const droppedCount = messages.length - kept.length;

  if (droppedCount === 0) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  // Create summary of dropped messages
  const dropped = messages.slice(0, droppedCount);
  const summary = createCompactionSummary(dropped);

  const compactedMessages: ChatMessage[] = [
    { role: "user", content: `[Previous conversation summary: ${summary}]` },
    ...kept,
  ];

  return { messages: compactedMessages, compacted: true, droppedCount };
}

function createCompactionSummary(messages: ChatMessage[]): string {
  const turns = Math.ceil(messages.length / 2);
  const toolCalls: string[] = [];

  for (const msg of messages) {
    if (typeof msg.content !== "string") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolCalls.push(block.name);
        }
      }
    }
  }

  const toolSummary = toolCalls.length > 0
    ? ` Tools used: ${[...new Set(toolCalls)].join(", ")}.`
    : "";

  return `${turns} conversation turns were compacted to save context.${toolSummary}`;
}
