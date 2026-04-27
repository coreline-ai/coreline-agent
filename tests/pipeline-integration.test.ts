/**
 * Pipeline integration tests — verifies pipeline mode through
 * SubAgentRuntime and AgentTool, including the subtasks+pipeline
 * mutual exclusion guard.
 */

import { describe, expect, test } from "bun:test";
import { DefaultSubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { createAppState } from "../src/agent/context.js";
import { AgentTool } from "../src/tools/agent/agent-tool.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import type { ChatRequest, ChatChunk, LLMProvider } from "../src/providers/types.js";
import type { Tool, ToolUseContext } from "../src/tools/types.js";
import type { SubAgentRuntime } from "../src/agent/subagent-types.js";

function createMockProvider(
  responder: (request: ChatRequest, callIndex: number) => ChatChunk[],
): LLMProvider & { callCount: number } {
  let callCount = 0;
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    get callCount() { return callCount; },
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      const chunks = responder(request, callCount++);
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeContext(provider: LLMProvider, tools: Tool[], runtime?: SubAgentRuntime): ToolUseContext {
  const state = createAppState({ cwd: process.cwd(), provider, tools, agentDepth: 0 });
  return {
    cwd: process.cwd(),
    abortSignal: state.abortController.signal,
    nonInteractive: true,
    permissionContext: state.permissionContext,
    agentDepth: 0,
    subAgentRuntime: runtime,
  };
}

describe("Pipeline through SubAgentRuntime", () => {
  test("TC-E.9: AgentTool pipeline input → SubAgentRuntime pipeline branch", async () => {
    let stageIndex = 0;
    const provider = createMockProvider((request) => {
      stageIndex++;
      const userMsg = request.messages.find((m) => m.role === "user");
      const text = typeof userMsg?.content === "string" ? userMsg.content : "";

      return [
        { type: "text_delta", text: `stage-${stageIndex}-done (received: ${text.slice(0, 50)})` },
        { type: "done", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 }, stopReason: "end_turn" },
      ];
    });

    const runtime = new DefaultSubAgentRuntime({
      provider,
      tools: [FileReadTool],
    });

    const result = await AgentTool.call(
      {
        prompt: "Run a 2-stage pipeline",
        pipeline: [
          { prompt: "analyze the code" },
          { prompt: "write a summary" },
        ],
      },
      makeContext(provider, [FileReadTool], runtime),
    );

    expect(result.isError).toBe(false);
    expect(result.data.reason).toBe("completed");
    expect(result.data.coordinator).toBe(true);
    expect(result.data.completedCount).toBe(2);

    const formatted = AgentTool.formatResult(result.data);
    expect(formatted).toContain("PIPELINE_RESULT");
    expect(formatted).toContain("stage-1");
    expect(formatted).toContain("stage-2");
  });

  test("pipeline + subtasks both present → error", async () => {
    const provider = createMockProvider(() => [
      { type: "done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" },
    ]);

    const runtime = new DefaultSubAgentRuntime({
      provider,
      tools: [FileReadTool],
    });

    const result = await AgentTool.call(
      {
        prompt: "conflicting request",
        pipeline: [{ prompt: "p1" }, { prompt: "p2" }],
        subtasks: [{ prompt: "s1" }],
      },
      makeContext(provider, [FileReadTool], runtime),
    );

    expect(result.data.reason).toBe("error");
    expect(result.data.finalText).toContain("Cannot use both");
  });

  test("TC-E.10: pipeline result formatResult → PIPELINE_RESULT format", async () => {
    const provider = createMockProvider(() => [
      { type: "text_delta", text: "ok" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" },
    ]);

    const runtime = new DefaultSubAgentRuntime({
      provider,
      tools: [FileReadTool],
    });

    const result = await AgentTool.call(
      {
        prompt: "pipeline test",
        pipeline: [
          { prompt: "step 1" },
          { prompt: "step 2" },
        ],
      },
      makeContext(provider, [FileReadTool], runtime),
    );

    const formatted = AgentTool.formatResult(result.data);
    expect(formatted).toContain("AGENT_RESULT");
    expect(formatted).toContain("mode: coordinator");
    expect(formatted).toContain("PIPELINE_RESULT");
  });
});
