/**
 * Shared contracts for single-agent hardening workstreams.
 *
 * These types are intentionally runtime-light so parallel workstreams can
 * depend on stable names without importing integration-layer code.
 */

import type { BackupEntry } from "./file-backup.js";

export type HardeningFailureKind =
  | "permission_denied"
  | "test_failed"
  | "hook_blocked"
  | "tool_error"
  | "rollback_failed";

export interface HardeningHint {
  kind: HardeningFailureKind;
  message: string;
  createdAt: string;
  source?: string;
}

export type GitToolAction = "status" | "diff" | "log" | "show" | "apply" | "stage" | "commit";

export type GitToolPermissionMode = "read" | "write";

export interface GitToolInput extends Record<string, unknown> {
  action: GitToolAction;
  pathspec?: string | string[];
  rev?: string;
  message?: string;
  patch?: string;
  maxOutputChars?: number;
}

export interface GitToolResult {
  action: GitToolAction;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  cwd: string;
  command: string[];
}

export interface ToolCachePolicy {
  ttlMs: number;
  maxEntries: number;
  includeMtime: boolean;
  includeRealpath: boolean;
}

export interface ToolCacheInvalidation {
  kind: "path" | "all";
  path?: string;
  removedEntries: number;
}

export interface ToolCacheRequest {
  cwd: string;
  toolName: string;
  input: unknown;
  paths?: string[];
}

export interface ToolCacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

export type FileTransactionStatus = "active" | "committed" | "rolled_back" | "rollback_partial";

export interface FileTransactionEntry {
  filePath: string;
  backup?: BackupEntry;
  addedAt: string;
}

export interface FileTransactionRecord {
  id: string;
  label?: string;
  startedAt: string;
  completedAt?: string;
  status: FileTransactionStatus;
  files: FileTransactionEntry[];
}

export interface FileTransactionRollbackFailure {
  filePath: string;
  message: string;
}

export interface FileTransactionRollbackReport {
  transactionId: string;
  restored: string[];
  failed: FileTransactionRollbackFailure[];
  invalidated: string[];
  status: "rolled_back" | "partial";
}

export interface HardeningTrack3Options {
  contextCompression?: HardeningTrack3ContextCompressionOptions;
  rateLimit?: HardeningTrack3RateLimitOptions;
  selfEvaluation?: HardeningTrack3SelfEvaluationOptions;
  adaptivePrompt?: HardeningTrack3AdaptivePromptOptions;
}

export interface HardeningTrack3ContextCompressionOptions {
  enabled: boolean;
  maxContextChars?: number;
  preserveRecentTurns?: number;
}

export interface HardeningTrack3RateLimitOptions {
  enabled: boolean;
  maxToolCallsPerMinute?: number;
  maxProviderCallsPerMinute?: number;
}

export interface HardeningTrack3SelfEvaluationOptions {
  enabled: boolean;
  minConfidence?: number;
  requireEvidence?: boolean;
}

export interface HardeningTrack3AdaptivePromptOptions {
  enabled: boolean;
  maxHints?: number;
  decayAfterTurns?: number;
}
