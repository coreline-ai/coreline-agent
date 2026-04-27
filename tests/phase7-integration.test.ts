/**
 * Phase 7 integration tests — end-to-end flows with mock provider.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../src/agent/loop.js";
import { createAppState } from "../src/agent/context.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { DefaultSubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { BashTool } from "../src/tools/bash/bash-tool.js";
import { FileReadTool } from "../src/tools/file-read/file-read-tool.js";
import { FileWriteTool } from "../src/tools/file-write/file-write-tool.js";
import { FileEditTool } from "../src/tools/file-edit/file-edit-tool.js";
import { GlobTool } from "../src/tools/glob/glob-tool.js";
import { GrepTool } from "../src/tools/grep/grep-tool.js";
import { AgentTool } from "../src/tools/agent/agent-tool.js";
import { SessionManager } from "../src/session/history.js";
import { getGitInfo } from "../src/utils/git.js";
import type { AgentEvent } from "../src/agent/types.js";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/types.js";
import type { Tool } from "../src/tools/types.js";

const ALL_TOOLS: Tool[] = [BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, AgentTool];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(responses: ChatChunk[][]): LLMProvider {
  let idx = 0;
  return {
    name: "mock", type: "openai-compatible", model: "mock", maxContextTokens: 100000,
    supportsToolCalling: true, supportsPlanning: false, supportsStreaming: true,
    async *send(): AsyncIterable<ChatChunk> {
      for (const c of responses[idx++] ?? []) yield c;
    },
  };
}

async function collectAll(gen: AsyncGenerator<AgentEvent, any>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return events;
}

// ---------------------------------------------------------------------------
// E2E: Multi-tool chain
// ---------------------------------------------------------------------------

describe("E2E: multi-step tool chain", () => {
  test("Glob → FileRead → text response", async () => {
    const provider = mockProvider([
      // Turn 1: LLM calls Glob
      [
        { type: "tool_call_start", toolCall: { id: "t1", name: "Glob" } },
        { type: "tool_call_delta", toolCallId: "t1", inputDelta: '{"pattern":"package.json"}' },
        { type: "tool_call_end", toolCallId: "t1" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "tool_use" },
      ],
      // Turn 2: LLM calls FileRead
      [
        { type: "tool_call_start", toolCall: { id: "t2", name: "FileRead" } },
        { type: "tool_call_delta", toolCallId: "t2", inputDelta: '{"file_path":"package.json"}' },
        { type: "tool_call_end", toolCallId: "t2" },
        { type: "done", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, stopReason: "tool_use" },
      ],
      // Turn 3: LLM responds with text
      [
        { type: "text_delta", text: "The project is coreline-agent v0.1.0" },
        { type: "done", usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({ cwd: process.cwd(), provider, tools: ALL_TOOLS, permissionMode: "acceptAll" });
    const events = await collectAll(agentLoop({
      state,
      messages: [{ role: "user", content: "What project is this?" }],
      systemPrompt: "test",
      maxTurns: 10,
    }));

    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(2);
    expect((toolStarts[0] as any).toolName).toBe("Glob");
    expect((toolStarts[1] as any).toolName).toBe("FileRead");

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    expect(state.totalUsage.inputTokens).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// E2E: Permission flow
// ---------------------------------------------------------------------------

describe("E2E: permission deny → LLM adapts", () => {
  test("rm denied, LLM says sorry", async () => {
    const provider = mockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "t1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "t1", inputDelta: '{"command":"rm -rf /tmp/test"}' },
        { type: "tool_call_end", toolCallId: "t1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "I cannot delete that." },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, stopReason: "end_turn" },
      ],
    ]);

    const state = createAppState({
      cwd: process.cwd(), provider, tools: ALL_TOOLS,
      permissionRules: [{ behavior: "deny", toolName: "Bash", pattern: "rm *" }],
    });

    const events = await collectAll(agentLoop({
      state,
      messages: [{ role: "user", content: "delete /tmp/test" }],
      systemPrompt: "test",
    }));

    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect((toolEnds[0] as any).isError).toBe(true);
    expect((toolEnds[0] as any).result).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// E2E: Agent delegation
// ---------------------------------------------------------------------------

describe("E2E: Agent delegation", () => {
  test("delegates code review to a child FileRead tool and returns only the compact Agent result", async () => {
    const provider = mockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "t_parent", name: "Agent" } },
        {
          type: "tool_call_delta",
          toolCallId: "t_parent",
          inputDelta: '{"prompt":"Review package.json and report the package name.","allowedTools":["FileRead"],"maxTurns":4}',
        },
        { type: "tool_call_end", toolCallId: "t_parent" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }, stopReason: "tool_use" },
      ],
      [
        { type: "tool_call_start", toolCall: { id: "t_child_1", name: "FileRead" } },
        { type: "tool_call_delta", toolCallId: "t_child_1", inputDelta: '{"file_path":"package.json"}' },
        { type: "tool_call_end", toolCallId: "t_child_1" },
        { type: "done", usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "package name is coreline-agent" },
        { type: "done", usage: { inputTokens: 14, outputTokens: 8, totalTokens: 22 }, stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "Delegated review: package name is coreline-agent." },
        { type: "done", usage: { inputTokens: 16, outputTokens: 9, totalTokens: 25 }, stopReason: "end_turn" },
      ],
    ]);

    const subAgentRuntime = new DefaultSubAgentRuntime({ provider, tools: ALL_TOOLS });
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: ALL_TOOLS,
      permissionMode: "acceptAll",
      subAgentRuntime,
    });

    const events = await collectAll(agentLoop({
      state,
      messages: [{ role: "user", content: "Review package.json via a delegated agent." }],
      systemPrompt: buildSystemPrompt(process.cwd(), ALL_TOOLS),
      maxTurns: 10,
    }));

    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolName).toBe("Agent");

    const agentToolEnd = events.find((e) => e.type === "tool_end" && (e as any).toolName === "Agent") as any;
    expect(agentToolEnd).toBeDefined();
    expect(agentToolEnd.result).toContain("AGENT_RESULT");
    expect(agentToolEnd.result).toContain("used_tools: FileRead");
    expect(agentToolEnd.result).toContain("package name is coreline-agent");

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.some((e: any) => e.text.includes("Delegated review"))).toBe(true);
  });

  test("delegates a bash-based test command without streaming the child transcript", async () => {
    const provider = mockProvider([
      [
        { type: "tool_call_start", toolCall: { id: "t_parent", name: "Agent" } },
        {
          type: "tool_call_delta",
          toolCallId: "t_parent",
          inputDelta: '{"prompt":"Run a quick delegated test command and report the output.","allowedTools":["Bash"],"maxTurns":4}',
        },
        { type: "tool_call_end", toolCallId: "t_parent" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }, stopReason: "tool_use" },
      ],
      [
        { type: "tool_call_start", toolCall: { id: "t_child_1", name: "Bash" } },
        { type: "tool_call_delta", toolCallId: "t_child_1", inputDelta: '{"command":"echo delegated-test-pass"}' },
        { type: "tool_call_end", toolCallId: "t_child_1" },
        { type: "done", usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 }, stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "delegated-test-pass" },
        { type: "done", usage: { inputTokens: 14, outputTokens: 8, totalTokens: 22 }, stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "Delegated test run says delegated-test-pass." },
        { type: "done", usage: { inputTokens: 16, outputTokens: 9, totalTokens: 25 }, stopReason: "end_turn" },
      ],
    ]);

    const subAgentRuntime = new DefaultSubAgentRuntime({ provider, tools: ALL_TOOLS });
    const state = createAppState({
      cwd: process.cwd(),
      provider,
      tools: ALL_TOOLS,
      permissionMode: "acceptAll",
      subAgentRuntime,
    });

    const events = await collectAll(agentLoop({
      state,
      messages: [{ role: "user", content: "Run a delegated smoke test." }],
      systemPrompt: buildSystemPrompt(process.cwd(), ALL_TOOLS),
      maxTurns: 10,
    }));

    const agentToolEnd = events.find((e) => e.type === "tool_end" && (e as any).toolName === "Agent") as any;
    expect(agentToolEnd).toBeDefined();
    expect(agentToolEnd.result).toContain("used_tools: Bash");
    expect(agentToolEnd.result).toContain("delegated-test-pass");

    const childToolEvents = events.filter((e) => e.type === "tool_end" && (e as any).toolName === "Bash");
    expect(childToolEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe("System prompt builder", () => {
  test("includes AGENT.md without project memory side effects", () => {
    const home = mkdtempSync(join(tmpdir(), "coreline-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "coreline-agent-only-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Project rules\nPrefer Bun.");

    const prevHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const prompt = buildSystemPrompt(workspace, ALL_TOOLS);
      expect(prompt).toContain("# Project Instructions");
      expect(prompt).toContain("Prefer Bun.");
      expect(existsSync(join(home, ".coreline-agent", "projects"))).toBe(false);
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("includes memory index when projectMemory is provided without AGENT.md", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "coreline-memory-root-"));
    const workspace = mkdtempSync(join(tmpdir(), "coreline-memory-only-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const memory = new ProjectMemory(workspace, { rootDir });
    memory.writeEntry({
      name: "project_rules",
      type: "project",
      description: "Core repo rules",
      body: "Do not edit outside the workspace.",
      filePath: "",
    });

    try {
      const prompt = buildSystemPrompt(workspace, ALL_TOOLS, memory);
      expect(prompt).toContain("# Memory");
      expect(prompt).toContain("project_rules");
      expect(prompt).not.toContain("# Project Instructions");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("includes cwd, tools, and date", () => {
    const prompt = buildSystemPrompt(process.cwd(), ALL_TOOLS);
    expect(prompt).toContain(process.cwd());
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("FileRead");
    expect(prompt).toContain("Glob");
    expect(prompt).toContain(new Date().toISOString().split("T")[0]!);
  });

  test("includes git info when in a repo", () => {
    const prompt = buildSystemPrompt(process.cwd(), ALL_TOOLS);
    const git = getGitInfo(process.cwd());
    if (git) {
      expect(prompt).toContain("Branch:");
    }
  });
});

// ---------------------------------------------------------------------------
// Git utils
// ---------------------------------------------------------------------------

describe("Git utils", () => {
  test("getGitInfo returns branch in a git repo", () => {
    const info = getGitInfo(process.cwd());
    // coreline-agent is a git repo
    expect(info).not.toBeNull();
    expect(info!.branch).toBeTruthy();
  });

  test("getGitInfo returns null outside git repo", () => {
    const info = getGitInfo("/tmp");
    expect(info).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

describe("Session persistence", () => {
  test("messages survive round-trip", () => {
    const session = new SessionManager({ providerName: "mock", model: "mock" });

    session.saveMessage({ role: "user", content: "hello" });
    session.saveMessage({
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
      ],
    });
    session.saveMessage({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "tool-1", content: "/tmp", isError: false }],
    });
    session.saveMessage({ role: "user", content: "how are you?" });

    const loaded = session.loadMessages();
    expect(loaded).toHaveLength(4);
    expect(loaded[0]!.role).toBe("user");
    expect(loaded[1]!.role).toBe("assistant");
    expect(loaded[2]!.role).toBe("user");
    expect(Array.isArray(loaded[2]!.content)).toBe(true);
    if (!Array.isArray(loaded[2]!.content)) {
      throw new Error("Expected tool_result content blocks");
    }
    expect(loaded[2]!.content[0]).toEqual({
      type: "tool_result",
      toolUseId: "tool-1",
      content: "/tmp",
      isError: false,
    });
    expect(loaded[3]!.role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// CLI non-interactive (smoke)
// ---------------------------------------------------------------------------

describe("CLI flags", () => {
  test("--help exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--help"], { cwd: process.cwd() });
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("--version exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--version"], { cwd: process.cwd() });
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("no provider exits 1", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_API_KEY: undefined, HOME: "/tmp/nonexistent-home" },
    });
    const code = await proc.exited;
    expect(code).toBe(1);
  });
});
