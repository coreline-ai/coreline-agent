/**
 * Tool Orchestration — parallel/serial execution of tool calls.
 *
 * Reference: Claude Code's toolOrchestration.ts pattern.
 * - Read-only + concurrency-safe tools → run in parallel
 * - Write tools → run serially
 * - Max concurrency: 10
 */

import type { ToolUseBlock } from "../agent/types.js";
import type { Tool, ToolUseContext, ToolResult } from "./types.js";
import type { HookResult } from "../hooks/index.js";
import {
  findBlockingHookResult,
  formatBlockingHookResult,
  formatPostToolBlockingHookResult,
  runPostToolHooks,
  runPreToolHooks,
  toolUseContextToPreToolHookContext,
} from "../hooks/permission-adapter.js";

const MAX_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  toolUseId: string;
  toolName: string;
  result: ToolResult;
  formattedResult: string;
}

interface PendingToolCall {
  block: ToolUseBlock;
  tool: Tool;
  parsedInput: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Partition tool calls by concurrency safety
// ---------------------------------------------------------------------------

function partitionToolCalls(
  calls: PendingToolCall[],
): Array<{ concurrent: boolean; calls: PendingToolCall[] }> {
  const groups: Array<{ concurrent: boolean; calls: PendingToolCall[] }> = [];
  let currentGroup: PendingToolCall[] = [];
  let currentConcurrent = false;

  for (const call of calls) {
    const isSafe = call.tool.isConcurrencySafe(call.parsedInput);

    if (currentGroup.length === 0) {
      currentConcurrent = isSafe;
      currentGroup.push(call);
    } else if (isSafe === currentConcurrent) {
      currentGroup.push(call);
    } else {
      groups.push({ concurrent: currentConcurrent, calls: currentGroup });
      currentGroup = [call];
      currentConcurrent = isSafe;
    }
  }

  if (currentGroup.length > 0) {
    groups.push({ concurrent: currentConcurrent, calls: currentGroup });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Execute a single tool call
// ---------------------------------------------------------------------------

async function executeSingle(
  call: PendingToolCall,
  context: ToolUseContext,
): Promise<ToolCallResult> {
  const { block, tool } = call;
  const hookContext = toolUseContextToPreToolHookContext(context);

  // PreTool hook insertion point: after permission approval + schema validation, before tool.call().
  const hookResults = await runPreToolHooks(
    context.hookEngine,
    block.name,
    call.parsedInput,
    hookContext,
  );
  const blockingHook = findBlockingHookResult(hookResults);
  if (blockingHook) {
    const message = formatBlockingHookResult(blockingHook);
    return {
      toolUseId: block.id,
      toolName: block.name,
      result: { data: message, isError: true },
      formattedResult: message,
    };
  }

  let result: ToolResult;
  try {
    // Execute
    result = await tool.call(call.parsedInput, context);
  } catch (err) {
    const errMsg = `Tool execution error: ${(err as Error).message}`;
    const errorResult: ToolResult<string> = { data: errMsg, isError: true };
    const postHookResults = await runPostToolHooks(
      context.hookEngine,
      block.name,
      call.parsedInput,
      errorResult.data,
      true,
      hookContext,
    );
    return {
      toolUseId: block.id,
      toolName: block.name,
      result: errorResult,
      formattedResult: appendPostToolBlockingMessage(errMsg, postHookResults),
    };
  }

  const postHookResults = await runPostToolHooks(
    context.hookEngine,
    block.name,
    call.parsedInput,
    result.data,
    result.isError ?? false,
    hookContext,
  );

  try {
    const formatted = appendPostToolBlockingMessage(
      tool.formatResult(result.data, block.id),
      postHookResults,
    );
    return {
      toolUseId: block.id,
      toolName: block.name,
      result,
      formattedResult: formatted,
    };
  } catch (err) {
    const errMsg = `Tool execution error: ${(err as Error).message}`;
    return {
      toolUseId: block.id,
      toolName: block.name,
      result: { data: errMsg, isError: true },
      formattedResult: appendPostToolBlockingMessage(errMsg, postHookResults),
    };
  }
}

function appendPostToolBlockingMessage(formattedResult: string, hookResults: HookResult[]): string {
  const blockingHook = findBlockingHookResult(hookResults);
  if (!blockingHook) return formattedResult;
  const message = formatPostToolBlockingHookResult(blockingHook);
  return formattedResult ? `${formattedResult}\n\n${message}` : message;
}

// ---------------------------------------------------------------------------
// Run tool calls with orchestration
// ---------------------------------------------------------------------------

export async function* runToolCalls(
  toolUseBlocks: ToolUseBlock[],
  tools: Map<string, Tool>,
  context: ToolUseContext,
): AsyncGenerator<ToolCallResult> {
  // Resolve tools for each block
  const pending: PendingToolCall[] = [];
  for (const block of toolUseBlocks) {
    const tool = tools.get(block.name);
    if (!tool) {
      yield {
        toolUseId: block.id,
        toolName: block.name,
        result: { data: `Unknown tool: ${block.name}`, isError: true },
        formattedResult: `Unknown tool: ${block.name}`,
      };
      continue;
    }

    const parseResult = tool.inputSchema.safeParse(block.input);
    if (!parseResult.success) {
      const errMsg = `Input validation error: ${parseResult.error.message}`;
      yield {
        toolUseId: block.id,
        toolName: block.name,
        result: { data: errMsg, isError: true },
        formattedResult: errMsg,
      };
      continue;
    }

    pending.push({ block, tool, parsedInput: parseResult.data });
  }

  // Partition and execute
  const groups = partitionToolCalls(pending);

  for (const group of groups) {
    if (group.concurrent) {
      // Run concurrently (up to MAX_CONCURRENCY)
      const batches: PendingToolCall[][] = [];
      for (let i = 0; i < group.calls.length; i += MAX_CONCURRENCY) {
        batches.push(group.calls.slice(i, i + MAX_CONCURRENCY));
      }

      for (const batch of batches) {
        const results = await Promise.all(
          batch.map((call) => executeSingle(call, context)),
        );
        for (const result of results) {
          yield result;
        }
      }
    } else {
      // Run serially
      for (const call of group.calls) {
        yield await executeSingle(call, context);
      }
    }
  }
}
