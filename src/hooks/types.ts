/**
 * Minimal internal Hook Engine contracts.
 *
 * This is an in-memory runtime foundation only. User-facing hook persistence,
 * public registration APIs, and TUI management are intentionally outside this
 * module. Command hooks are internal-only and disabled unless explicitly opted in.
 */

import type { PermissionCheckContext } from "../permissions/types.js";

export type HookEventName = "SessionStart" | "SessionEnd" | "StatusChange" | "PreTool" | "PostTool";

export interface BaseHookInput {
  event: HookEventName;
  sessionId?: string;
  action?: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface StatusChangeHookInput extends BaseHookInput {
  event: "StatusChange";
  status?: string;
  previousStatus?: string;
  snapshot?: unknown;
}

export interface PreToolHookInput extends BaseHookInput {
  event: "PreTool";
  toolName: string;
  input?: unknown;
}

export interface PostToolHookInput extends BaseHookInput {
  event: "PostTool";
  toolName: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface SessionLifecycleHookInput extends BaseHookInput {
  event: "SessionStart" | "SessionEnd";
  reason?: string;
}

export type HookInput =
  | StatusChangeHookInput
  | PreToolHookInput
  | PostToolHookInput
  | SessionLifecycleHookInput;

export type HookType = "function" | "http" | "command";

export interface BaseHookConfig {
  id?: string;
  name?: string;
  event: HookEventName;
  /** Exact/contains/wildcard match against input.action or input.toolName. */
  matcher?: string;
  /** Minimal expression form, for example: Bash(git *). */
  if?: string;
  type: HookType;
  timeoutMs?: number;
  once?: boolean;
}

export interface HookCallbackResult {
  blocking?: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface HookCallbackContext {
  signal?: AbortSignal;
}

export type HookCallback = (
  input: HookInput,
  context: HookCallbackContext,
) => HookCallbackResult | void | Promise<HookCallbackResult | void>;

export interface FunctionHookConfig extends BaseHookConfig {
  type: "function";
  handler: HookCallback;
}

export interface HttpHookConfig extends BaseHookConfig {
  type: "http";
  url: string;
  /** Explicit safe headers only. No ambient credentials are forwarded. */
  headers?: Record<string, string>;
  /** Additional hosts allowed beyond localhost/127.0.0.1/::1. */
  allowedHosts?: string[];
}

export interface CommandHookConfig extends BaseHookConfig {
  type: "command";
  command: string;
  /**
   * Optional cwd relative to the execution context cwd. Absolute paths are only
   * allowed when they remain inside the execution context cwd.
   */
  cwd?: string;
  /** Explicit environment values. Only envAllowlist keys survive. */
  env?: Record<string, string | undefined>;
  /** Process/config env keys allowed through after credential-name stripping. */
  envAllowlist?: string[];
  stdoutLimitChars?: number;
  stderrLimitChars?: number;
}

export type HookConfig = FunctionHookConfig | HttpHookConfig | CommandHookConfig;

export interface HookExecutionContext {
  cwd: string;
  nonInteractive: boolean;
  permissionContext?: PermissionCheckContext;
}

export interface HookResult {
  hookId: string;
  hookName?: string;
  type: HookType;
  blocking: boolean;
  durationMs: number;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
