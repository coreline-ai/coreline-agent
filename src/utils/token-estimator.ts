/**
 * Token estimator — rough token counting for context window budgeting.
 *
 * Uses character-based heuristic (no external tokenizer dependency).
 * Accuracy: ~85% for English, ~70% for CJK.
 */

import type { ChatMessage, ContentBlock } from "../agent/types.js";

// Rough ratios: English ~3.5 chars/token, CJK ~1.5 chars/token
const CHARS_PER_TOKEN_LATIN = 3.5;
const CHARS_PER_TOKEN_CJK = 1.5;
const CJK_REGEX = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  const cjkChars = (text.match(CJK_REGEX) ?? []).length;
  const latinChars = text.length - cjkChars;
  return Math.ceil(latinChars / CHARS_PER_TOKEN_LATIN + cjkChars / CHARS_PER_TOKEN_CJK);
}

function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "tool_use": return `[tool_use: ${block.name}] ${JSON.stringify(block.input)}`;
    case "tool_result": return `[tool_result] ${block.content}`;
    case "image": return "[image]";
  }
}

export function estimateMessageTokens(msg: ChatMessage): number {
  // Overhead per message (role, formatting)
  const overhead = 4;
  if (typeof msg.content === "string") {
    return overhead + estimateTokens(msg.content);
  }
  const text = msg.content.map(contentBlockToText).join("\n");
  return overhead + estimateTokens(text);
}

export function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}
