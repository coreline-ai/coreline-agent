/**
 * AgentTool parallel-dev guidance tests.
 */

import { describe, expect, test } from "bun:test";
import { DefaultSubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { buildSubAgentSystemPrompt } from "../src/agent/system-prompt.js";
import { createAppState } from "../src/agent/context.js";
import { AgentTool } from "../src/tools/agent/agent-tool.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import type { Tool, ToolUseContext } from "../src/tools/types.js";

function createMockProvider(
  responder: (request: ChatRequest, callIndex: number) => ChatChunk[],
): LLMProvider & { requests: ChatRequest[] } {
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
    async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(request);
      const chunks = responder(request, callCount++);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function makeContext(provider: LLMProvider, tools: Tool[], runtime?: DefaultSubAgentRuntime): ToolUseContext {
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

describe("AgentTool parallel-dev guidance", () => {
  test("buildSubAgentSystemPrompt includes guidance only when provided", () => {
    const withGuidance = buildSubAgentSystemPrompt(
      process.cwd(),
      [],
      "Investigate the change.",
      undefined,
      undefined,
      {
        ownedPaths: ["src/agent/a.ts"],
        nonOwnedPaths: ["src/index.ts"],
        contracts: ["merge after review"],
        mergeNotes: "Prefer small commits.",
      },
    );

    expect(withGuidance).toContain("# Parallel Dev Guidance");
    expect(withGuidance).toContain("Owned paths: src/agent/a.ts");
    expect(withGuidance).toContain("Non-owned paths: src/index.ts");
    expect(withGuidance).toContain("Contracts: merge after review");
    expect(withGuidance).toContain("Merge notes: Prefer small commits.");

    const withoutGuidance = buildSubAgentSystemPrompt(process.cwd(), [], "Investigate the change.");
    expect(withoutGuidance).not.toContain("# Parallel Dev Guidance");
  });

  test("AgentTool input schema accepts guidance on subtasks and pipeline stages", () => {
    const parsed = AgentTool.inputSchema.safeParse({
      prompt: "Root task",
      ownedPaths: ["src/agent/root.ts"],
      nonOwnedPaths: ["src/index.ts"],
      contracts: ["root contract"],
      mergeNotes: "Merge after all children finish.",
      subtasks: [
        {
          prompt: "Child task",
          ownedPaths: ["src/agent/child.ts"],
          nonOwnedPaths: ["src/tui/repl.tsx"],
          contracts: ["child contract"],
          mergeNotes: "Return only summary text.",
        },
      ],
      pipeline: [
        {
          prompt: "Stage one",
          ownedPaths: ["src/agent/stage-1.ts"],
          nonOwnedPaths: ["src/session/export.ts"],
          contracts: ["stage one contract"],
          mergeNotes: "Keep it minimal.",
        },
        {
          prompt: "Stage two",
          ownedPaths: ["src/agent/stage-2.ts"],
          nonOwnedPaths: ["src/tui/status-bar.tsx"],
          contracts: ["stage two contract"],
          mergeNotes: "No extra scope.",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  test("subtask guidance reaches the child system prompt", async () => {
    const provider = createMockProvider(() => [
      { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" },
    ]);
    const runtime = new DefaultSubAgentRuntime({
      provider,
      tools: [],
    });

    const result = await AgentTool.call(
      {
        prompt: "Spawn the child.",
        subtasks: [
          {
            prompt: "Child task",
            ownedPaths: ["src/agent/child.ts"],
            nonOwnedPaths: ["src/index.ts"],
            contracts: ["child contract"],
            mergeNotes: "Keep the diff tiny.",
          },
        ],
      },
      makeContext(provider, [], runtime),
    );

    expect(result.isError).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.systemPrompt).toContain("# Parallel Dev Guidance");
    expect(provider.requests[0]!.systemPrompt).toContain("Owned paths: src/agent/child.ts");
    expect(provider.requests[0]!.systemPrompt).toContain("Merge notes: Keep the diff tiny.");
  });

  test("pipeline stage guidance reaches each stage prompt", async () => {
    const provider = createMockProvider((request, callIndex) => [
      {
        type: "text_delta",
        text: `stage-${callIndex + 1}:${request.messages.find((message) => message.role === "user")?.content ?? ""}`,
      },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" },
    ]);
    const runtime = new DefaultSubAgentRuntime({
      provider,
      tools: [],
    });

    const result = await AgentTool.call(
      {
        prompt: "Run a 2-stage pipeline.",
        pipeline: [
          {
            prompt: "Stage one",
            ownedPaths: ["src/agent/stage-1.ts"],
            mergeNotes: "Only stage one output.",
          },
          {
            prompt: "Stage two",
            ownedPaths: ["src/agent/stage-2.ts"],
            mergeNotes: "Only stage two output.",
          },
        ],
      },
      makeContext(provider, [], runtime),
    );

    expect(result.isError).toBe(false);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.systemPrompt).toContain("Owned paths: src/agent/stage-1.ts");
    expect(provider.requests[0]!.systemPrompt).toContain("Merge notes: Only stage one output.");
    expect(provider.requests[1]!.systemPrompt).toContain("Owned paths: src/agent/stage-2.ts");
    expect(provider.requests[1]!.systemPrompt).toContain("Merge notes: Only stage two output.");
  });
});
