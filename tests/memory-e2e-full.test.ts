import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { getProjectId } from "../src/memory/project-id.js";
import { MemoryWriteTool } from "../src/tools/memory-write/memory-write-tool.js";
import { MemoryReadTool } from "../src/tools/memory-read/memory-read-tool.js";
import { createAppState, toToolUseContext } from "../src/agent/context.js";
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

describe("Memory system full E2E scenarios", () => {
  let rootDir: string;
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "coreline-memory-root-"));
    workspaceA = mkdtempSync(join(tmpdir(), "coreline-memory-workspace-a-"));
    workspaceB = mkdtempSync(join(tmpdir(), "coreline-memory-workspace-b-"));

    mkdirSync(join(workspaceA, ".git"), { recursive: true });
    mkdirSync(join(workspaceB, ".git"), { recursive: true });

    writeFileSync(join(workspaceA, "AGENT.md"), "# Project rules\nPrefer Bun.\n");
    writeFileSync(join(workspaceB, "AGENT.md"), "# Project rules\nPrefer Node.\n");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  });

  test("MemoryWrite creates project memory files through tool context", async () => {
    const projectMemory = new ProjectMemory(workspaceA, { rootDir });
    const state = createAppState({
      cwd: workspaceA,
      provider: createMockProvider(),
      tools: [MemoryReadTool, MemoryWriteTool],
      projectMemory,
    });
    const context = toToolUseContext(state);

    const result = await MemoryWriteTool.call(
      {
        name: "runtime_pref",
        type: "user",
        description: "Preferred runtime",
        body: "Use Bun for scripts.",
      },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(existsSync(join(projectMemory.memoryDir, "runtime_pref.md"))).toBe(true);
    expect(existsSync(join(projectMemory.memoryDir, "MEMORY.md"))).toBe(true);
  });

  test("restarting with a new ProjectMemory instance reloads persisted memory", async () => {
    const projectMemory = new ProjectMemory(workspaceA, { rootDir });
    projectMemory.writeEntry({
      name: "runtime_pref",
      type: "user",
      description: "Preferred runtime",
      body: "Use Bun for scripts.",
      filePath: "",
    });

    const reloaded = new ProjectMemory(workspaceA, { rootDir });
    const entry = reloaded.readEntry("runtime_pref");

    expect(entry).not.toBeNull();
    expect(entry?.body).toContain("Use Bun for scripts.");
    expect(reloaded.listEntries().map((item) => item.name)).toContain("runtime_pref");

    const state = createAppState({
      cwd: workspaceA,
      provider: createMockProvider(),
      tools: [MemoryReadTool, MemoryWriteTool],
      projectMemory: reloaded,
    });
    const context = toToolUseContext(state);
    const readResult = await MemoryReadTool.call({ name: "runtime_pref" }, context);

    expect(readResult.isError).toBeUndefined();
    if (readResult.data.mode !== "entry") {
      throw new Error("Expected entry mode");
    }

    const formatted = MemoryReadTool.formatResult(readResult.data, "memory-read-entry");
    expect(formatted).toContain("MEMORY_READ_RESULT");
    expect(formatted).toContain("mode: entry");
    expect(formatted).toContain("answer_hint:");
    expect(formatted).toContain("name: runtime_pref");
    expect(formatted).toContain("ENTRY_BODY_START");
    expect(formatted).toContain("Use Bun for scripts.");
    expect(formatted).toContain("ENTRY_BODY_END");
  });

  test("same cwd resolves to the same project id", () => {
    const first = new ProjectMemory(workspaceA, { rootDir });
    const second = new ProjectMemory(workspaceA, { rootDir });

    expect(first.projectId).toBe(second.projectId);
    expect(first.projectId).toBe(getProjectId(workspaceA));
  });

  test("different cwd values stay isolated", () => {
    const memoryA = new ProjectMemory(workspaceA, { rootDir });
    const memoryB = new ProjectMemory(workspaceB, { rootDir });

    memoryA.writeEntry({
      name: "project_rule",
      type: "project",
      description: "A-only rule",
      body: "Only workspace A should see this.",
      filePath: "",
    });

    expect(memoryA.projectId).not.toBe(memoryB.projectId);
    expect(memoryB.readEntry("project_rule")).toBeNull();
  });

  test("system prompt includes both AGENT.md instructions and MEMORY index", () => {
    const projectMemory = new ProjectMemory(workspaceA, { rootDir });
    projectMemory.writeEntry({
      name: "project_rule",
      type: "project",
      description: "Formatting rule",
      body: "Always run bun test before reporting done.",
      filePath: "",
    });

    const prompt = buildSystemPrompt(
      workspaceA,
      [MemoryReadTool, MemoryWriteTool],
      projectMemory,
      createMockProvider(),
    );

    expect(prompt).toContain("# Project Instructions");
    expect(prompt).toContain("Prefer Bun.");
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("project_rule");

    const memoryIndex = readFileSync(join(projectMemory.memoryDir, "MEMORY.md"), "utf-8");
    expect(memoryIndex).toContain("project_rule");
  });
});
