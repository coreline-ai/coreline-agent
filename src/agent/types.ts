/**
 * Core agent types — messages, events, and tool interactions.
 *
 * Design reference: Claude Code queryLoop() state machine pattern.
 * All types are provider-agnostic; provider adapters convert to/from these.
 */

// ---------------------------------------------------------------------------
// Content Blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  base64: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage | SystemMessage;

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Agent Events (yielded from the agent loop async generator)
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  text: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolProgressEvent {
  type: "tool_progress";
  toolUseId: string;
  toolName: string;
  output: string;
}

export interface ToolEndEvent {
  type: "tool_end";
  toolUseId: string;
  toolName: string;
  result: string;
  isError: boolean;
}

export interface TurnEndEvent {
  type: "turn_end";
  reason: TurnEndReason;
  usage: Usage;
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface WarningEvent {
  type: "warning";
  message: string;
  code?: string;
}

export interface WatchdogTimeoutEvent {
  type: "watchdog_timeout";
  timeoutSeconds: number;
  elapsedMs: number;
  lastLabel?: string;
  message: string;
}

export interface LoopDetectedEvent {
  type: "loop_detected";
  toolName: string;
  inputHash: string;
  consecutiveCount: number;
  threshold: number;
  message: string;
}

export interface PermissionAskEvent {
  type: "permission_ask";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (allowed: boolean) => void;
}

export type AgentEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolEndEvent
  | TurnEndEvent
  | ErrorEvent
  | WarningEvent
  | WatchdogTimeoutEvent
  | LoopDetectedEvent
  | PermissionAskEvent;

// ---------------------------------------------------------------------------
// Turn End Reasons
// ---------------------------------------------------------------------------

export type TurnEndReason =
  | "completed"        // LLM finished without tool calls
  | "aborted"          // user cancelled (Ctrl+C)
  | "max_turns"        // maxTurns limit reached
  | "error"            // unrecoverable error
  | "permission_denied"; // user denied a required tool

// ---------------------------------------------------------------------------
// Agent Loop Parameters
// ---------------------------------------------------------------------------

export interface AgentLoopParams {
  messages: ChatMessage[];
  systemPrompt: string;
  maxTurns?: number;
  signal?: AbortSignal;
}
