import type { HookEngine, HookResult, PostToolHookInput, PreToolHookInput } from "./index.js";
import type { ToolUseContext } from "../tools/types.js";
import type { PermissionCheckContext } from "../permissions/types.js";

export interface PreToolHookContext {
  cwd: string;
  nonInteractive: boolean;
  agentDepth?: number;
  abortSignal?: AbortSignal;
  permissionContext?: PermissionCheckContext;
}

export type PostToolHookContext = PreToolHookContext;

export async function runPreToolHooks(
  engine: HookEngine | undefined,
  toolName: string,
  input: Record<string, unknown>,
  context: PreToolHookContext,
): Promise<HookResult[]> {
  if (!engine) return [];
  const hookInput: PreToolHookInput = {
    event: "PreTool",
    toolName,
    input,
    action: inferAction(input),
    target: inferAction(input),
    metadata: {
      cwd: context.cwd,
      nonInteractive: context.nonInteractive,
      agentDepth: context.agentDepth,
    },
  };
  try {
    return await engine.execute("PreTool", hookInput, context.abortSignal, {
      cwd: context.cwd,
      nonInteractive: context.nonInteractive,
      permissionContext: context.permissionContext,
    });
  } catch (err) {
    return [{
      hookId: "pretool-dispatch",
      hookName: "PreTool dispatch",
      type: "function",
      blocking: false,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    }];
  }
}

export async function runPostToolHooks(
  engine: HookEngine | undefined,
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
  isError: boolean,
  context: PostToolHookContext,
): Promise<HookResult[]> {
  if (!engine) return [];
  const hookInput: PostToolHookInput = {
    event: "PostTool",
    toolName,
    input,
    result,
    isError,
    action: inferAction(input),
    target: inferAction(input),
    metadata: {
      cwd: context.cwd,
      nonInteractive: context.nonInteractive,
      agentDepth: context.agentDepth,
    },
  };
  try {
    return await engine.execute("PostTool", hookInput, context.abortSignal, {
      cwd: context.cwd,
      nonInteractive: context.nonInteractive,
      permissionContext: context.permissionContext,
    });
  } catch (err) {
    return [{
      hookId: "posttool-dispatch",
      hookName: "PostTool dispatch",
      type: "function",
      blocking: false,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    }];
  }
}

export function findBlockingHookResult(results: HookResult[]): HookResult | undefined {
  return results.find((result) => result.blocking);
}

export function formatBlockingHookResult(result: HookResult): string {
  const name = result.hookName ?? result.hookId;
  return `Tool blocked by hook ${name}${result.message ? `: ${result.message}` : ""}`;
}

export function formatPostToolBlockingHookResult(result: HookResult): string {
  const name = result.hookName ?? result.hookId;
  return `PostTool hook ${name} returned blocking after tool execution${result.message ? `: ${result.message}` : ""}`;
}

export function toolUseContextToPreToolHookContext(context: ToolUseContext): PreToolHookContext {
  return {
    cwd: context.cwd,
    nonInteractive: context.nonInteractive,
    agentDepth: context.agentDepth,
    abortSignal: context.abortSignal,
    permissionContext: context.permissionContext,
  };
}

function inferAction(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "file_path", "path", "query", "pattern", "prompt"]) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
