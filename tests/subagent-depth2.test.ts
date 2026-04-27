/**
 * Depth-2 sub-agent recursion tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import { DefaultSubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { createAppState } from "../src/agent/context.js";
import { AgentTool } from "../src/tools/agent/agent-tool.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import type { Tool } from "../src/tools/types.js";
import type { SubAgentRunRecord } from "../src/session/records.js";

function mkTempDir(): string {
  return mkdtempSync(join(tmpdir(), "coreline-depth2-"));
}

function makeContext(
  cwd: string,
  provider: LLMProvider,
  tools: Tool[],
  agentDepth = 0,
  saveSubAgentRun?: (record: Omit<SubAgentRunRecord, "_type" | "sessionId" | "createdAt" | "childId"> & {
    childId?: string;
    id?: string;
    sessionId?: string;
    createdAt?: string;
  }) => void,
) {
  const state = createAppState({
    cwd,
    provider,
    tools,
    agentDepth,
    saveSubAgentRun,
  });

  return {
    state,
    context: {
      cwd,
      abortSignal: state.abortController.signal,
      nonInteractive: true,
      projectMemory: undefined,
      permissionContext: state.permissionContext,
      agentDepth: state.agentDepth,
      subAgentRuntime: state.subAgentRuntime,
      saveSubAgentRun: state.saveSubAgentRun,
    },
  };
}

function createMockProvider(
  responder: (request: ChatRequest, callIndex: number) => ChatChunk[],
): LLMProvider & { requests: ChatRequest[]; callCount: number } {
  const requests: ChatRequest[] = [];
  let callCount = 0;

  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    requests,
    get callCount() {
      return callCount;
    },
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(request);
      const chunks = responder(request, callCount++);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe("depth-2 sub-agent recursion", () => {
  test("allows a depth-1 child to recurse once while stripping depth-2 write and Agent tools", async () => {
    const cwd = mkTempDir();
    try {
      const notePath = join(cwd, "note.txt");
      writeFileSync(notePath, "depth-two note\n");

      const provider = createMockProvider((request, callIndex) => {
        if (callIndex === 0) {
          return [
            { type: "tool_call_start", toolCall: { id: "tc_agent", name: "Agent" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_agent",
              inputDelta: JSON.stringify({
                prompt: "Depth 2 child should only see read-only tools.",
                allowedTools: ["Agent", "FileRead"],
                maxTurns: 3,
              }),
            },
            { type: "tool_call_end", toolCallId: "tc_agent" },
            { type: "done", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, stopReason: "tool_use" },
          ];
        }

        if (callIndex === 1) {
          expect(request.tools?.map((tool) => tool.name)).toEqual(["FileRead"]);
          return [
            { type: "tool_call_start", toolCall: { id: "tc_read", name: "FileRead" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_read",
              inputDelta: JSON.stringify({ file_path: notePath, offset: 0, limit: 1 }),
            },
            { type: "tool_call_end", toolCallId: "tc_read" },
            { type: "done", usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 }, stopReason: "tool_use" },
          ];
        }

        if (callIndex === 2) {
          return [
            { type: "text_delta", text: "depth-2 read-only child complete" },
            { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "end_turn" },
          ];
        }

        return [
          { type: "text_delta", text: "depth-1 parent complete" },
          { type: "done", usage: { inputTokens: 7, outputTokens: 6, totalTokens: 13 }, stopReason: "end_turn" },
        ];
      });

      const saved: Array<Record<string, unknown>> = [];
      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [AgentTool, FileReadTool, FileWriteTool],
      });

      const { context } = makeContext(cwd, provider, [AgentTool, FileReadTool, FileWriteTool], 0, (record) => {
        saved.push(record as Record<string, unknown>);
      });

      const result = await AgentTool.call(
        {
          prompt: "Delegate one nested child.",
          allowedTools: ["Agent", "FileRead", "FileWrite"],
          debug: true,
        },
        {
          ...context,
          subAgentRuntime: runtime,
        },
      );

      expect(result.isError).toBe(false);
      expect(provider.callCount).toBe(4);
      expect(provider.requests).toHaveLength(4);
      expect(provider.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["Agent", "FileRead"]);
      expect(provider.requests[1]!.tools?.map((tool) => tool.name)).toEqual(["FileRead"]);
      expect(provider.requests[1]!.systemPrompt).toContain("Sub-Agent Mode");
      expect(provider.requests[2]!.tools?.map((tool) => tool.name)).toEqual(["FileRead"]);
      expect(provider.requests[3]!.tools?.map((tool) => tool.name)).toEqual(["Agent", "FileRead"]);
      expect(result.data.finalText).toContain("depth-1 parent complete");
      expect(saved.some((record) => record.agentDepth === 1)).toBe(true);
      expect(saved.some((record) => record.agentDepth === 2)).toBe(true);
      const depth2Record = saved.find((record) => record.agentDepth === 2);
      expect(depth2Record?.status).toBe("completed");
      expect(depth2Record?.usedTools).toEqual(["FileRead"]);
      expect(depth2Record?.summary).toContain("depth-2 read-only child complete");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("applies the depth-2 maxTurns cap to recursive children", async () => {
    const cwd = mkTempDir();
    try {
      const note1 = join(cwd, "note-1.txt");
      const note2 = join(cwd, "note-2.txt");
      const note3 = join(cwd, "note-3.txt");
      writeFileSync(note1, "one\n");
      writeFileSync(note2, "two\n");
      writeFileSync(note3, "three\n");

      const provider = createMockProvider((request, callIndex) => {
        if (callIndex === 0) {
          return [
            { type: "tool_call_start", toolCall: { id: "tc_agent", name: "Agent" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_agent",
              inputDelta: JSON.stringify({
                prompt: "Run a capped depth-2 child.",
                allowedTools: ["Agent", "FileRead"],
                maxTurns: 8,
              }),
            },
            { type: "tool_call_end", toolCallId: "tc_agent" },
            { type: "done", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, stopReason: "tool_use" },
          ];
        }

        if (callIndex === 1) {
          return [
            { type: "tool_call_start", toolCall: { id: "tc_read_1", name: "FileRead" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_read_1",
              inputDelta: JSON.stringify({ file_path: note1, offset: 0, limit: 1 }),
            },
            { type: "tool_call_end", toolCallId: "tc_read_1" },
            { type: "done", usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 }, stopReason: "tool_use" },
          ];
        }

        if (callIndex === 2) {
          return [
            { type: "tool_call_start", toolCall: { id: "tc_read_2", name: "FileRead" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_read_2",
              inputDelta: JSON.stringify({ file_path: note2, offset: 0, limit: 1 }),
            },
            { type: "tool_call_end", toolCallId: "tc_read_2" },
            { type: "done", usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 }, stopReason: "tool_use" },
          ];
        }

        if (callIndex === 3) {
          return [
            { type: "tool_call_start", toolCall: { id: "tc_read_3", name: "FileRead" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_read_3",
              inputDelta: JSON.stringify({ file_path: note3, offset: 0, limit: 1 }),
            },
            { type: "tool_call_end", toolCallId: "tc_read_3" },
            { type: "done", usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 }, stopReason: "tool_use" },
          ];
        }

        return [
          { type: "text_delta", text: "depth-1 finished after capped child" },
          { type: "done", usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 }, stopReason: "end_turn" },
        ];
      });

      const saved: Array<Record<string, unknown>> = [];
      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [AgentTool, FileReadTool],
      });

      const { context } = makeContext(cwd, provider, [AgentTool, FileReadTool], 0, (record) => {
        saved.push(record as Record<string, unknown>);
      });

      const result = await AgentTool.call(
        {
          prompt: "Delegate a capped nested child.",
          allowedTools: ["Agent", "FileRead"],
          debug: true,
        },
        {
          ...context,
          subAgentRuntime: runtime,
        },
      );

      expect(result.isError).toBe(false);
      expect(provider.callCount).toBe(5);
      expect(provider.requests[1]!.tools?.map((tool) => tool.name)).toEqual(["FileRead"]);
      expect(provider.requests[2]!.tools?.map((tool) => tool.name)).toEqual(["FileRead"]);
      expect(provider.requests[3]!.tools?.map((tool) => tool.name)).toEqual(["FileRead"]);
      const depth2Record = saved.find((record) => record.agentDepth === 2);
      expect(depth2Record?.status).toBe("error");
      expect(depth2Record?.summary).toBe("max_turns");
      expect(depth2Record?.turns).toBe(3);
      expect(depth2Record?.usedTools).toEqual(["FileRead"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
