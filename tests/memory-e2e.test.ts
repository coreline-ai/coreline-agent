import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppState, toToolUseContext } from "../src/agent/context.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { MemoryReadTool } from "../src/tools/memory-read/memory-read-tool.js";
import { MemoryWriteTool } from "../src/tools/memory-write/memory-write-tool.js";
import type { LLMProvider } from "../src/providers/types.js";

function createMockProvider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 100_000,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send() {
      return;
    },
  };
}

describe("Memory system wiring", () => {
  let rootDir: string;
  let workspace: string;
  let projectMemory: ProjectMemory;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "coreline-memory-root-"));
    workspace = mkdtempSync(join(tmpdir(), "coreline-memory-workspace-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Project rules\nPrefer Bun.");
    projectMemory = new ProjectMemory(workspace, { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("MemoryWrite then MemoryRead round-trip through tool context", async () => {
    const state = createAppState({
      cwd: workspace,
      provider: createMockProvider(),
      tools: [MemoryReadTool, MemoryWriteTool],
      projectMemory,
    });
    const context = toToolUseContext(state);

    const writeResult = await MemoryWriteTool.call(
      {
        name: "user_profile",
        type: "user",
        description: "Runtime preference",
        body: "Use Bun runtime for tests.",
      },
      context,
    );

    expect(writeResult.isError).toBeUndefined();
    expect("isNew" in writeResult.data && writeResult.data.isNew).toBe(true);

    const listResult = await MemoryReadTool.call({}, context);
    expect(listResult.isError).toBeUndefined();
    if (listResult.data.mode !== "list") {
      throw new Error("Expected list mode");
    }
    expect(listResult.data.entries).toHaveLength(1);
    expect(listResult.data.entries[0]?.name).toBe("user_profile");

    const listText = MemoryReadTool.formatResult(listResult.data, "memory-read-list");
    expect(listText).toContain("MEMORY_READ_RESULT");
    expect(listText).toContain("mode: list");
    expect(listText).toContain("summary: 1 memory entry available");
    expect(listText).toContain("ENTRIES_START");
    expect(listText).toContain("name: user_profile");
    expect(listText).toContain("description: Runtime preference");
    expect(listText).toContain("preview: Use Bun runtime for tests.");
    expect(listText).toContain("NEXT_STEP: Call MemoryRead");

    const readResult = await MemoryReadTool.call({ name: "user_profile" }, context);
    expect(readResult.isError).toBeUndefined();
    if (readResult.data.mode !== "entry") {
      throw new Error("Expected entry mode");
    }
    expect(readResult.data.entry.body).toContain("Use Bun runtime");

    const readText = MemoryReadTool.formatResult(readResult.data, "memory-read-entry");
    expect(readText).toContain("MEMORY_READ_RESULT");
    expect(readText).toContain("mode: entry");
    expect(readText).toContain("summary: memory entry loaded");
    expect(readText).toContain("answer_hint:");
    expect(readText).toContain("name: user_profile");
    expect(readText).toContain("type: user");
    expect(readText).toContain("description: Runtime preference");
    expect(readText).toContain("ENTRY_BODY_START");
    expect(readText).toContain("Use Bun runtime for tests.");
    expect(readText).toContain("ENTRY_BODY_END");
  });

  test("system prompt includes AGENT.md and memory index when available", async () => {
    projectMemory.writeEntry({
      name: "project_rules",
      type: "project",
      description: "Core repo rules",
      body: "Do not edit outside the workspace.",
      filePath: "",
    });

    const prompt = buildSystemPrompt(workspace, [MemoryReadTool, MemoryWriteTool], projectMemory);

    expect(prompt).toContain("# Project Instructions");
    expect(prompt).toContain("Prefer Bun.");
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("project_rules");
    expect(prompt).toContain("Use MemoryWrite");
  });

  test("memory tools return helpful errors when project memory is missing", async () => {
    const state = createAppState({
      cwd: workspace,
      provider: createMockProvider(),
      tools: [MemoryReadTool, MemoryWriteTool],
    });
    const context = toToolUseContext(state);

    const readResult = await MemoryReadTool.call({}, context);
    const writeResult = await MemoryWriteTool.call(
      {
        name: "user_profile",
        type: "user",
        description: "Runtime preference",
        body: "Use Bun runtime for tests.",
      },
      context,
    );

    expect(readResult.isError).toBe(true);
    expect(writeResult.isError).toBe(true);
  });
});
