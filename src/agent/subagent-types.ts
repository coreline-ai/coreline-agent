/**
 * Sub-agent runtime contracts and MVP/v2 extension types.
 */

import type { LLMProvider } from "../providers/types.js";
import type { ToolUseContext } from "../tools/types.js";
import type { ChatMessage, Usage } from "./types.js";

export interface SubAgentArtifact {
  kind: "summary" | "final_text" | "tools" | "status" | "failure";
  label: string;
  value: string;
}

export interface SubAgentTaskRequest {
  prompt: string;
  allowedTools?: string[];
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
  contracts?: string[];
  mergeNotes?: string;
  maxTurns?: number;
  timeoutMs?: number;
  provider?: string;
  model?: string;
  write?: boolean;
  debug?: boolean;
}

export interface PipelineStageRef {
  prompt: string;
  contextPrefix?: string;
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
  contracts?: string[];
  mergeNotes?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  allowedTools?: string[];
}

export interface SubAgentRequest extends SubAgentTaskRequest {
  /** Parallel child batch (coordinator mode) */
  subtasks?: SubAgentTaskRequest[];
  /** Sequential handoff chain — each stage receives the prior result as context */
  pipeline?: PipelineStageRef[];
}

export type SubAgentChildStatus = "completed" | "failed" | "aborted" | "timeout";

export interface SubAgentDebugRecord {
  id: string;
  kind: "single" | "coordinator" | "child";
    request: {
      prompt: string;
      allowedTools?: string[];
      ownedPaths?: string[];
      nonOwnedPaths?: string[];
      contracts?: string[];
      mergeNotes?: string;
      maxTurns?: number;
      timeoutMs?: number;
      provider?: string;
      model?: string;
    write?: boolean;
    debug?: boolean;
    subtasks?: number;
  };
  provider: {
    name: string;
    type: LLMProvider["type"];
    model?: string;
  };
  startedAt: number;
  finishedAt: number;
  transcript: ChatMessage[];
}

export interface SubAgentChildResult {
  id: string;
  prompt: string;
  status: SubAgentChildStatus;
  provider: string;
  model?: string;
  write: boolean;
  finalText: string;
  summary: string;
  turns: number;
  usedTools: string[];
  usage: Usage;
  reason?: string;
  error?: string;
  debug?: SubAgentDebugRecord;
  artifacts?: SubAgentArtifact[];
}

export interface SubAgentFailure {
  id: string;
  prompt: string;
  status: Exclude<SubAgentChildStatus, "completed">;
  provider: string;
  model?: string;
  write: boolean;
  message: string;
}

export interface SubAgentResult {
  finalText: string;
  summary: string;
  turns: number;
  usedTools: string[];
  usage: Usage;
  reason?: string;
  coordinator?: boolean;
  partial?: boolean;
  childCount?: number;
  completedCount?: number;
  failedCount?: number;
  children?: SubAgentChildResult[];
  failures?: SubAgentFailure[];
  debug?: SubAgentDebugRecord;
  artifacts?: SubAgentArtifact[];
}

export interface SubAgentProviderResolverInput {
  request: SubAgentTaskRequest;
  context: ToolUseContext;
  parentProvider: LLMProvider;
}

export type SubAgentProviderResolver =
  (input: SubAgentProviderResolverInput) => Promise<LLMProvider> | LLMProvider;

export interface SubAgentRuntime {
  run(request: SubAgentRequest, context: ToolUseContext): Promise<SubAgentResult>;
  runMany?(requests: SubAgentTaskRequest[], context: ToolUseContext): Promise<SubAgentResult>;
}

export const SUB_AGENT_DEFAULT_MAX_TURNS = 6;
export const SUB_AGENT_MAX_TURNS = 8;
export const SUB_AGENT_MAX_DEPTH = 2;
export const SUB_AGENT_DEPTH2_DEFAULT_MAX_TURNS = 3;
export const SUB_AGENT_DEPTH2_MAX_TURNS = 3;
export const SUB_AGENT_DEPTH2_DEFAULT_TIMEOUT_MS = 15_000;
export const SUB_AGENT_DEPTH2_MAX_TIMEOUT_MS = 15_000;
export const SUB_AGENT_DEFAULT_CHILDREN = 4;
export const SUB_AGENT_DEFAULT_TOOL_ALLOWLIST = [
  "Glob",
  "Grep",
  "FileRead",
  "MemoryRead",
  "Bash",
] as const;
export const SUB_AGENT_WRITE_TOOL_ALLOWLIST = [
  "FileWrite",
  "FileEdit",
  "MemoryWrite",
] as const;
