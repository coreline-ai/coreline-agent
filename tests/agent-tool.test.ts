/**
 * AgentTool MVP tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgentTool } from "../src/tools/agent/agent-tool.js";
import type { ToolUseContext } from "../src/tools/types.js";
import type { SubAgentResult, SubAgentRuntime } from "../src/agent/subagent-types.js";
import { buildTool } from "../src/tools/types.js";
import { ParallelAgentScheduler } from "../src/agent/parallel/scheduler.js";

const runtimeStub: SubAgentRuntime = {
  async run(request) {
    const finalText = `Child result for: ${request.prompt}`;
    return {
      finalText,
      summary: finalText,
      turns: 2,
      usedTools: ["FileRead"],
      usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
      reason: "completed",
      artifacts: [
        { kind: "status", label: "status", value: "completed" },
        { kind: "summary", label: "summary", value: finalText },
        { kind: "final_text", label: "final text", value: finalText },
      ],
    };
  },
};

function makeContext(overrides?: Partial<ToolUseContext>): ToolUseContext {
  return {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    nonInteractive: true,
    projectMemory: undefined,
    permissionContext: {
      cwd: process.cwd(),
      mode: "default",
      rules: [],
    },
    agentDepth: 0,
    subAgentRuntime: runtimeStub,
    ...overrides,
  };
}

describe("AgentTool", () => {
  test("delegates to the runtime and formats a deterministic result", async () => {
    const result = await AgentTool.call(
      {
        prompt: "Review src/index.ts",
        allowedTools: ["FileRead", "Agent"],
        maxTurns: 3,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.data.finalText).toContain("Child result for: Review src/index.ts");
    expect(result.data.usedTools).toEqual(["FileRead"]);
    expect(result.data.artifacts?.some((artifact) => artifact.label === "summary")).toBe(true);

    const formatted = AgentTool.formatResult(result.data);
    expect(formatted).toContain("AGENT_RESULT");
    expect(formatted).toContain("reason: completed");
    expect(formatted).toContain("status: completed");
    expect(formatted).toContain("turns: 2");
    expect(formatted).toContain("used_tools: FileRead");
    expect(formatted).toContain("ARTIFACTS");
    expect(formatted).toContain("final text");
    expect(formatted).toContain("FINAL_TEXT_START");
    expect(formatted).toContain("Child result for: Review src/index.ts");
  });

  test("denies nested calls from depth 2 or deeper", () => {
    const decision = AgentTool.checkPermissions(
      { prompt: "nested" },
      makeContext({ agentDepth: 2 }),
    );

    expect(decision.behavior).toBe("deny");
    expect(decision.reason).toContain("depth 2");
  });

  test("returns a structured error when no runtime is wired", async () => {
    const result = await AgentTool.call(
      { prompt: "Review src/index.ts" },
      makeContext({ subAgentRuntime: undefined }),
    );

    expect(result.isError).toBe(true);
    expect(result.data.reason).toBe("runtime_unavailable");
    expect(AgentTool.formatResult(result.data)).toContain("runtime_unavailable");
  });

  test("asks for permission when write-capable child tools are requested", () => {
    const decision = AgentTool.checkPermissions(
      {
        prompt: "Implement a fix",
        allowedTools: ["FileRead", "FileWrite"],
        write: true,
      },
      makeContext(),
    );

    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toContain("write-capable");
  });

  test("injects a workstream card into delegated prompts when path ownership is provided", async () => {
    const seenPrompts: string[] = [];
    const result = await AgentTool.call(
      {
        prompt: "Implement WS-B",
        write: true,
        ownedPaths: ["src/tools/agent/agent-tool.ts"],
        nonOwnedPaths: ["src/tui/repl.tsx"],
        contracts: ["Do not break permission flow"],
        mergeNotes: "Main worker integrates docs later",
      },
      makeContext({
        subAgentRuntime: {
          async run(request) {
            seenPrompts.push(request.prompt);
            return {
              finalText: "done",
              summary: "done",
              turns: 1,
              usedTools: [],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              reason: "completed",
            };
          },
        },
      }),
    );

    expect(result.isError).toBe(false);
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain("[WORKSTREAM_CARD]");
    expect(seenPrompts[0]).toContain("src/tools/agent/agent-tool.ts");
    expect(seenPrompts[0]).toContain("src/tui/repl.tsx");
    expect(seenPrompts[0]).toContain("Do not break permission flow");
    expect(seenPrompts[0]).toContain("non-owned paths are read-only references");
  });

  test("injects workstream cards into background task prompts", async () => {
    const scheduler = new ParallelAgentScheduler({ maxParallelAgentTasks: 1 });
    const result = await AgentTool.call(
      {
        prompt: "Implement background WS",
        description: "background ws",
        runInBackground: true,
        ownedPaths: ["src/owned.ts"],
        nonOwnedPaths: ["src/not-owned.ts"],
      },
      makeContext({
        supportsBackgroundTasks: true,
        parallelAgentRegistry: scheduler.registry,
        parallelAgentScheduler: scheduler,
        providerName: "mock",
        providerModel: "mock-model",
      }),
    );

    expect(result.isError).toBe(false);
    const task = scheduler.registry.getTask("parallel-task-0001");
    expect(task?.prompt).toContain("[WORKSTREAM_CARD]");
    expect(task?.prompt).toContain("src/owned.ts");

    await scheduler.waitForIdle();
    const completed = scheduler.registry.getTask("parallel-task-0001");
    expect(completed?.summary).toContain("[WORKSTREAM_CARD]");
  });


  test("starts a background parallel agent task when the TUI context supports it", async () => {
    const scheduler = new ParallelAgentScheduler({ maxParallelAgentTasks: 1 });
    const result = await AgentTool.call(
      {
        prompt: "Review src/index.ts",
        description: "review index",
        runInBackground: true,
      },
      makeContext({
        supportsBackgroundTasks: true,
        parallelAgentRegistry: scheduler.registry,
        parallelAgentScheduler: scheduler,
        providerName: "mock",
        providerModel: "mock-model",
      }),
    );

    expect(result.isError).toBe(false);
    expect(result.data.finalText).toContain("PARALLEL_AGENT_TASK_STARTED");
    expect(result.data.finalText).toContain("/agent status parallel-task-0001");

    await scheduler.waitForIdle();
    const task = scheduler.registry.getTask("parallel-task-0001");
    expect(task?.status).toBe("completed");
    expect(task?.description).toBe("review index");
    expect(task?.summary).toContain("Child result for: Review src/index.ts");
  });

  test("returns an explicit error for background requests in one-shot contexts", async () => {
    const result = await AgentTool.call(
      {
        prompt: "Review src/index.ts",
        runInBackground: true,
      },
      makeContext({ supportsBackgroundTasks: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.data.reason).toBe("background_unavailable");
    expect(result.data.finalText).toContain("interactive TUI");
  });

  test("persists child debug records when a recorder is available", async () => {
    const saved: Array<Record<string, unknown>> = [];

    const result = await AgentTool.call(
      {
        prompt: "Review src/index.ts",
        debug: true,
      },
      makeContext({
        saveSubAgentRun: (record) => {
          saved.push(record as Record<string, unknown>);
        },
        subAgentRuntime: {
          async run(request) {
            return {
              finalText: `Child result for: ${request.prompt}`,
              summary: "Child result",
              turns: 1,
              usedTools: ["FileRead"],
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              reason: "completed",
              debug: {
                id: "single",
                kind: "single",
                request: {
                  prompt: request.prompt,
                  debug: true,
                },
                provider: {
                  name: "mock",
                  type: "openai-compatible",
                  model: "mock-model",
                },
                startedAt: 1,
                finishedAt: 2,
                transcript: [
                  { role: "user", content: request.prompt },
                  { role: "assistant", content: [{ type: "text", text: "done" }] },
                ],
              },
            };
          },
        },
      }),
    );

    expect(result.isError).toBe(false);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      childId: "single",
      prompt: "Review src/index.ts",
      summary: "Child result",
      finalText: "Child result for: Review src/index.ts",
      usedTools: ["FileRead"],
      success: true,
      status: "completed",
      resultKind: "single",
    });
  });
});
