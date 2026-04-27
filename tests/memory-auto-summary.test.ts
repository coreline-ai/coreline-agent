/**
 * Memory auto-summary tests — conversation-end summary persistence.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../src/agent/loop.js";
import { createAppState } from "../src/agent/context.js";
import { buildSubAgentSystemPrompt } from "../src/agent/system-prompt.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import type { LLMProvider, ChatChunk, ChatRequest } from "../src/providers/types.js";

function createMockProvider(responses: ChatChunk[][]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send(_request: ChatRequest): AsyncIterable<ChatChunk> {
      const chunks = responses[callIndex++] ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function collectAll(gen: AsyncGenerator<any, any>): Promise<void> {
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

describe("Memory auto-summary", () => {
  let rootDir: string;
  let workspace: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "coreline-auto-summary-root-"));
    workspace = mkdtempSync(join(tmpdir(), "coreline-auto-summary-workspace-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Project rules\nPrefer Bun.");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("writes a project summary when a root conversation completes", async () => {
    const projectMemory = new ProjectMemory(workspace, { rootDir });
    const provider = createMockProvider([
      [
        { type: "text_delta", text: "Understood. " },
        { type: "text_delta", text: "I'll keep Bun as the default runtime and prefer local proxy workflows." },
        { type: "done", usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: workspace,
      provider,
      tools: [],
      projectMemory,
    });

    const loop = agentLoop({
      state,
      messages: [
        {
          role: "user",
          content: "Remember to keep Bun as the default runtime and prefer local proxy workflows.",
        },
      ],
      systemPrompt: "You are helpful.",
      autoSummary: true,
    });

    await collectAll(loop);

    const summary = projectMemory.readEntry("auto_summary");
    expect(summary).not.toBeNull();
    expect(summary?.type).toBe("project");
    expect(summary?.description).toContain("Auto-generated summary");
    expect(summary?.body).toContain("Goal");
    expect(summary?.body).toContain("Bun as the default runtime");
    expect(summary?.body).toContain("local proxy workflows");
    expect(summary?.body).toContain("Outcome");
    expect(existsSync(join(projectMemory.memoryDir, "auto_summary.md"))).toBe(true);
  });

  test("does not write a summary when auto-summary is disabled", async () => {
    const projectMemory = new ProjectMemory(workspace, { rootDir });
    const provider = createMockProvider([
      [
        { type: "text_delta", text: "Done." },
        { type: "done", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: workspace,
      provider,
      tools: [],
      projectMemory,
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "Remember this for later." }],
      systemPrompt: "You are helpful.",
      autoSummary: false,
    });

    await collectAll(loop);

    expect(projectMemory.readEntry("auto_summary")).toBeNull();
  });

  test("skips internal sub-agent conversations", async () => {
    const projectMemory = new ProjectMemory(workspace, { rootDir });
    const provider = createMockProvider([
      [
        { type: "text_delta", text: "Child finished." },
        { type: "done", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: workspace,
      provider,
      tools: [],
      projectMemory,
      agentDepth: 1,
    });

    const loop = agentLoop({
      state,
      messages: [{ role: "user", content: "Remember this child result." }],
      systemPrompt: buildSubAgentSystemPrompt(workspace, [], "Remember this child result."),
      autoSummary: true,
    });

    await collectAll(loop);

    expect(projectMemory.readEntry("auto_summary")).toBeNull();
  });
});
