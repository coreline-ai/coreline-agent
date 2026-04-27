/**
 * Transcript normalization for searchable/replayable session entries.
 */

import type { ChatMessage, ContentBlock } from "../agent/types.js";

export interface TranscriptEntryRecord {
  _type: "transcript_entry";
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant" | "tool";
  toolName?: string;
  toolUseId?: string;
  text: string;
  tokenCount?: number;
  turnIndex: number;
}

export interface NormalizeMessageOptions {
  sessionId?: string;
  timestamp?: string;
  tokenCount?: number;
  toolNameById?: Map<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text";
}

function isToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
}

function isToolResultBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_result" }> {
  return block.type === "tool_result";
}

function toEntryTimestamp(timestamp?: string): string {
  return timestamp ?? new Date().toISOString();
}

function createEntry(
  sessionId: string,
  timestamp: string,
  role: TranscriptEntryRecord["role"],
  turnIndex: number,
  text: string,
  extras: Partial<Pick<TranscriptEntryRecord, "toolName" | "toolUseId" | "tokenCount">> = {},
): TranscriptEntryRecord {
  return {
    _type: "transcript_entry",
    sessionId,
    timestamp,
    role,
    text,
    turnIndex,
    ...extras,
  };
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
}

function normalizeUserMessage(
  message: Extract<ChatMessage, { role: "user" }>,
  turnIndex: number,
  sessionId: string,
  timestamp: string,
  options: NormalizeMessageOptions,
): TranscriptEntryRecord[] {
  if (typeof message.content === "string") {
    return [
      createEntry(sessionId, timestamp, "user", turnIndex, message.content, { tokenCount: options.tokenCount }),
    ];
  }

  const textParts = message.content.filter(isTextBlock).map((block) => block.text).filter((text) => text.length > 0);
  const entries: TranscriptEntryRecord[] = [];
  if (textParts.length > 0) {
    entries.push(createEntry(sessionId, timestamp, "user", turnIndex, textParts.join("\n"), { tokenCount: options.tokenCount }));
  }

  for (const block of message.content) {
    if (!isToolResultBlock(block)) {
      continue;
    }

    const toolName = options.toolNameById?.get(block.toolUseId);
    entries.push(
      createEntry(sessionId, timestamp, "tool", turnIndex, block.content, {
        toolName,
        toolUseId: block.toolUseId,
        tokenCount: options.tokenCount,
      }),
    );
  }

  if (entries.length === 0) {
    entries.push(createEntry(sessionId, timestamp, "user", turnIndex, contentToText(message.content), { tokenCount: options.tokenCount }));
  }

  return entries;
}

function normalizeAssistantMessage(
  message: Extract<ChatMessage, { role: "assistant" }>,
  turnIndex: number,
  sessionId: string,
  timestamp: string,
  options: NormalizeMessageOptions,
): TranscriptEntryRecord[] {
  const entries: TranscriptEntryRecord[] = [];
  const blocks = Array.isArray(message.content) ? message.content : [];

  for (const block of blocks) {
    if (isTextBlock(block)) {
      if (block.text.trim().length === 0) {
        continue;
      }
      entries.push(createEntry(sessionId, timestamp, "assistant", turnIndex, block.text, { tokenCount: options.tokenCount }));
      continue;
    }

    if (isToolUseBlock(block)) {
      options.toolNameById?.set(block.id, block.name);
      entries.push(
        createEntry(sessionId, timestamp, "assistant", turnIndex, JSON.stringify(block.input ?? {}), {
          toolName: block.name,
          toolUseId: block.id,
          tokenCount: options.tokenCount,
        }),
      );
    }
  }

  return entries;
}

/**
 * Normalize a chat message into transcript entries suitable for search/replay.
 */
export function normalizeMessage(
  msg: ChatMessage,
  turnIndex: number,
  options: NormalizeMessageOptions = {},
): TranscriptEntryRecord[] {
  const sessionId = options.sessionId ?? "unknown-session";
  const timestamp = toEntryTimestamp(options.timestamp);

  if (msg.role === "system") {
    return [];
  }

  if (msg.role === "user") {
    return normalizeUserMessage(msg, turnIndex, sessionId, timestamp, options);
  }

  if (msg.role === "assistant") {
    return normalizeAssistantMessage(msg, turnIndex, sessionId, timestamp, options);
  }

  return [];
}

export function isTranscriptEntryRecord(value: unknown): value is TranscriptEntryRecord {
  return isRecord(value)
    && value._type === "transcript_entry"
    && typeof value.sessionId === "string"
    && typeof value.timestamp === "string"
    && (value.role === "user" || value.role === "assistant" || value.role === "tool")
    && typeof value.text === "string"
    && typeof value.turnIndex === "number";
}

