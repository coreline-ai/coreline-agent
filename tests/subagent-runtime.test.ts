/**
 * Sub-agent runtime MVP/v2 tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DefaultSubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { createAppState } from "../src/agent/context.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import { MemoryReadTool } from "../src/tools/memory-read/memory-read-tool.js";
import { BashTool } from "../src/tools/bash/bash-tool.js";
import { buildTool } from "../src/tools/types.js";
import type { ChatRequest, ChatChunk, LLMProvider } from "../src/providers/types.js";
import type { Tool } from "../src/tools/types.js";
import type { SubAgentDebugRecord } from "../src/agent/subagent-types.js";

const WriteMockTool = buildTool({
  name: "WriteMock",
  description: "write mock",
  inputSchema: z.object({}),
  async call() {
    return { data: "write" };
  },
  formatResult(output) {
    return String(output);
  },
});

const AgentMockTool = buildTool({
  name: "Agent",
  description: "agent mock",
  inputSchema: z.object({}),
  async call() {
    return { data: "agent" };
  },
  formatResult(output) {
    return String(output);
  },
});

function createDeferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function mkTempDir(): string {
  return mkdtempSync(join(tmpdir(), "coreline-subagent-"));
}

function makeContext(cwd: string, provider: LLMProvider, tools: Tool[], agentDepth = 0) {
  const state = createAppState({
    cwd,
    provider,
    tools,
    agentDepth,
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
      subAgentRuntime: undefined,
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

function createBlockingProvider(opts?: {
  name?: string;
  model?: string;
  targetStarts?: number;
  textPrefix?: string;
}) {
  const requests: ChatRequest[] = [];
  let callCount = 0;
  let startedCount = 0;
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const targetStarts = opts?.targetStarts ?? 1;
  const textPrefix = opts?.textPrefix ?? "child";

  const provider: LLMProvider & { requests: ChatRequest[]; callCount: number } = {
    name: opts?.name ?? "blocking",
    type: "openai-compatible",
    model: opts?.model ?? "blocking-model",
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
      const callIndex = callCount++;
      startedCount += 1;
      if (startedCount >= targetStarts) {
        started.resolve();
      }

      await Promise.race([release.promise, waitForAbort(request.signal)]);
      if (request.signal.aborted) {
        throw new Error(`blocked request ${callIndex} aborted`);
      }

      yield { type: "text_delta", text: `${textPrefix}-${callIndex + 1}` };
      yield {
        type: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn",
      };
    },
  };

  return { provider, requests, started, release };
}

describe("DefaultSubAgentRuntime", () => {
  test("keeps the single-child MVP flow and filters write tools by default", async () => {
    const cwd = mkTempDir();
    try {
      const filePath = join(cwd, "note.txt");
      writeFileSync(filePath, "runtime: bun\n");

      const provider = createMockProvider((request, callIndex) => {
        if (callIndex === 0) {
          return [
            { type: "tool_call_start", toolCall: { id: "tc_1", name: "FileRead" } },
            {
              type: "tool_call_delta",
              toolCallId: "tc_1",
              inputDelta: JSON.stringify({ file_path: filePath, offset: 0, limit: 1 }),
            },
            { type: "tool_call_end", toolCallId: "tc_1" },
            { type: "done", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, stopReason: "tool_use" },
          ];
        }

        return [
          {
            type: "text_delta",
            text:
              "This is a deliberately long final answer from the child agent. " +
              "It should be truncated into the summary without invoking another model call. " +
              "The parent should only receive the compact result object, not the full transcript. " +
              "This sentence is repeated to push the response over the summary limit. ".repeat(4),
          },
          { type: "done", usage: { inputTokens: 18, outputTokens: 26, totalTokens: 44 }, stopReason: "end_turn" },
        ];
      });

      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [FileReadTool, FileWriteTool, MemoryReadTool, BashTool, WriteMockTool, AgentMockTool],
      });

      const { context } = makeContext(cwd, provider, []);

      const result = await runtime.run(
        {
          prompt: "Read the note and answer with the important fact.",
          allowedTools: ["FileRead", "MemoryRead", "FileWrite", "WriteMock", "Agent", "FileRead"],
          maxTurns: 4,
        },
        context,
      );

      expect(provider.callCount).toBe(2);
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["FileRead", "MemoryRead", "Agent"]);
      expect(provider.requests[0]!.systemPrompt).toContain("Sub-Agent Mode");
      expect(provider.requests[0]!.systemPrompt).toContain("Read the note");
      expect(result.reason).toBe("completed");
      expect(result.turns).toBe(2);
      expect(result.usedTools).toEqual(["FileRead"]);
      expect(result.finalText).toContain("deliberately long final answer");
      expect(result.summary.length).toBeLessThan(result.finalText.length);
      expect(result.summary.endsWith("…")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("allows write tools only when write=true", async () => {
    const cwd = mkTempDir();
    try {
      const provider = createMockProvider((_request) => [
        { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn" },
      ]);

      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [FileReadTool, FileWriteTool],
      });

      const { context } = makeContext(cwd, provider, []);

      await runtime.run(
        {
          prompt: "Inspect the file list.",
          allowedTools: ["FileRead", "FileWrite"],
          write: true,
        },
        context,
      );

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["FileRead", "FileWrite"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resolves provider/model overrides through the provider hook", async () => {
    const cwd = mkTempDir();
    try {
      const baseProvider = createMockProvider(() => [
        { type: "done", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }, stopReason: "end_turn" },
      ]);
      baseProvider.name = "base-provider";
      baseProvider.model = "base-model";
      const overrideProvider = createMockProvider(() => [
        {
          type: "text_delta",
          text: "served-by-override",
        },
        { type: "done", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 }, stopReason: "end_turn" },
      ]);
      overrideProvider.name = "override-provider";
      overrideProvider.model = "override-model-runtime";

      const runtime = new DefaultSubAgentRuntime({
        provider: baseProvider,
        tools: [FileReadTool],
        providerResolver: ({ request }) => {
          if (request.provider === "override" || request.model === "override-model") {
            return overrideProvider;
          }
          return baseProvider;
        },
      });

      const { context } = makeContext(cwd, baseProvider, []);

      const result = await runtime.run(
        {
          prompt: "Use the override provider.",
          provider: "override",
          model: "override-model",
          debug: true,
        },
        context,
      );

      expect(baseProvider.requests).toHaveLength(0);
      expect(overrideProvider.requests).toHaveLength(1);
      expect(result.finalText).toContain("served-by-override");
      expect(result.debug?.provider.name).toBe("override-provider");
      expect(result.debug?.request.provider).toBe("override");
      expect(result.debug?.request.model).toBe("override-model");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("runs coordinator subtasks in parallel and emits debug records", async () => {
    const cwd = mkTempDir();
    try {
      const { provider, started, release } = createBlockingProvider({ targetStarts: 2, textPrefix: "parallel" });
      const debugRecords: SubAgentDebugRecord[] = [];
      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [FileReadTool],
        onDebugRecord: (record) => debugRecords.push(record),
      });

      const { context } = makeContext(cwd, provider, []);

      const runPromise = runtime.run(
        {
          prompt: "Run the two child tasks at once.",
          debug: true,
          subtasks: [
            { prompt: "first child" },
            { prompt: "second child" },
          ],
        },
        context,
      );

      await started.promise;
      expect(provider.callCount).toBe(2);
      release.resolve();

      const result = await runPromise;
      expect(result.coordinator).toBe(true);
      expect(result.reason).toBe("completed");
      expect(result.partial).toBe(false);
      expect(result.childCount).toBe(2);
      expect(result.completedCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.children).toHaveLength(2);
      expect(result.children?.every((child) => child.status === "completed")).toBe(true);
      expect(result.children?.every((child) => child.debug?.kind === "child")).toBe(true);
      expect(result.artifacts?.some((artifact) => artifact.label === "mode")).toBe(true);
      expect(result.children?.every((child) => child.artifacts?.some((artifact) => artifact.label === "summary"))).toBe(true);
      expect(result.debug?.kind).toBe("coordinator");
      expect(debugRecords.map((record) => record.kind)).toContain("coordinator");
      expect(debugRecords.filter((record) => record.kind === "child")).toHaveLength(2);
      expect(result.finalText).toContain("COORDINATOR_RESULT");
      expect(result.finalText).toContain("status: completed");
      expect(result.finalText).toContain("used_tools:");
      expect(result.finalText).toContain("first child");
      expect(result.finalText).toContain("second child");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reports partial failures when one child fails and the rest complete", async () => {
    const cwd = mkTempDir();
    try {
      const provider = createMockProvider((_request, callIndex) => {
        if (callIndex === 0) {
          return [
            { type: "text_delta", text: "first child ok" },
            { type: "done", usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 }, stopReason: "end_turn" },
          ];
        }

        throw new Error("boom");
      });

      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [FileReadTool],
      });

      const { context } = makeContext(cwd, provider, []);

      const result = await runtime.run(
        {
          prompt: "Run one good child and one bad child.",
          subtasks: [
            { prompt: "good child" },
            { prompt: "bad child" },
          ],
        },
        context,
      );

      expect(result.coordinator).toBe(true);
      expect(result.reason).toBe("error");
      expect(result.partial).toBe(true);
      expect(result.childCount).toBe(2);
      expect(result.completedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.children?.[0]?.status).toBe("completed");
      expect(result.children?.[1]?.status).toBe("failed");
      expect(result.artifacts?.some((artifact) => artifact.label === "failed")).toBe(true);
      expect(result.failures).toHaveLength(1);
      expect(result.failures?.[0]?.message).toBe("error");
      expect(result.finalText).toContain("FAILURES");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("times out coordinator children and marks the batch partial", async () => {
    const cwd = mkTempDir();
    try {
      const { provider, started } = createBlockingProvider({ targetStarts: 1, textPrefix: "timeout" });
      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [FileReadTool],
      });

      const { context } = makeContext(cwd, provider, []);

      const resultPromise = runtime.run(
        {
          prompt: "Timeout the child.",
          timeoutMs: 20,
          subtasks: [{ prompt: "slow child" }],
        },
        context,
      );

      await started.promise;
      const result = await resultPromise;

      expect(result.coordinator).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.reason).toBe("error");
      expect(result.children?.[0]?.status).toBe("timeout");
      expect(result.failures?.[0]?.status).toBe("timeout");
      expect(result.failures?.[0]?.message).toContain("timed out");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("propagates parent abort to all child tasks", async () => {
    const cwd = mkTempDir();
    try {
      const { provider, started } = createBlockingProvider({ targetStarts: 2, textPrefix: "abort" });
      const runtime = new DefaultSubAgentRuntime({
        provider,
        tools: [FileReadTool],
      });

      const { state, context } = makeContext(cwd, provider, []);

      const resultPromise = runtime.run(
        {
          prompt: "Abort both children.",
          subtasks: [
            { prompt: "child a" },
            { prompt: "child b" },
          ],
        },
        context,
      );

      await started.promise;
      state.abortController.abort();

      const result = await resultPromise;
      expect(result.coordinator).toBe(true);
      expect(result.reason).toBe("aborted");
      expect(result.partial).toBe(true);
      expect(result.children?.every((child) => child.status === "aborted")).toBe(true);
      expect(result.failures?.every((failure) => failure.status === "aborted")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("blocks nested execution when already at depth 2", async () => {
    const provider = createMockProvider(() => []);
    const runtime = new DefaultSubAgentRuntime({
      provider,
      tools: [FileReadTool],
    });

    const result = await runtime.run(
      {
        prompt: "This should never run.",
      },
      makeContext(process.cwd(), provider, [], 2).context,
    );

    expect(result.reason).toBe("depth_limit");
    expect(result.finalText).toContain("depth limit");
    expect(provider.callCount).toBe(0);
  });
});
