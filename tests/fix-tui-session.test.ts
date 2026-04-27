/**
 * WS-P0C tests — TUI session prop flow + resume display restoration.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { App } from "../src/tui/app.js";
import { ThemeProvider } from "../src/tui/theme/context.js";
import { REPL, buildDisplayMessagesFromMessages } from "../src/tui/repl.js";
import { createAppState } from "../src/agent/context.js";
import type { ChatMessage } from "../src/agent/types.js";
import { prepareUserPrompt } from "../src/prompt/index.js";
import type { LLMProvider, ProviderRegistry } from "../src/providers/types.js";
import type { SessionManager } from "../src/session/history.js";

function createMockProvider(): LLMProvider {
  return {
    name: "mock",
    type: "openai-compatible",
    model: "mock-model",
    maxContextTokens: 8192,
    supportsToolCalling: true,
    supportsPlanning: false,
    supportsStreaming: true,
    async *send() {
      return;
    },
  };
}

function createMockSession(messages: ChatMessage[] = []): SessionManager {
  return {
    sessionId: "session-123",
    loadMessages: () => messages,
    saveMessage: () => undefined,
  } as unknown as SessionManager;
}

function createMockProviderRegistry(provider: LLMProvider): ProviderRegistry {
  return {
    getProvider: () => provider,
    listProviders: () => [provider.name],
    getDefault: () => provider,
    setDefault: () => undefined,
  };
}

describe("TUI session wiring", () => {
  test("App forwards session and UI props to REPL", () => {
    const provider = createMockProvider();
    const state = createAppState({ cwd: process.cwd(), provider, tools: [] });
    const session = createMockSession();
    const providerRegistry = createMockProviderRegistry(provider);

    const wrapper = App({
      state,
      providerRegistry,
      systemPrompt: "system prompt",
      maxTurns: 7,
      session,
      showReasoning: false,
    }) as React.ReactElement;

    // App wraps REPL in ThemeProvider
    expect(wrapper.type).toBe(ThemeProvider);
    const element = wrapper.props.children as React.ReactElement;
    expect(element.type).toBe(REPL);
    expect(element.props.state).toBe(state);
    expect(element.props.providerRegistry).toBe(providerRegistry);
    expect(element.props.systemPrompt).toBe("system prompt");
    expect(element.props.maxTurns).toBe(7);
    expect(element.props.session).toBe(session);
    expect(element.props.showReasoning).toBe(false);
  });

  test("resume session messages are reconstructed into displayMessages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "How many files are here?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "tool-1", content: "src\ntests", isError: false },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "\nDone." },
        ],
      },
    ];

    const displayMessages = buildDisplayMessagesFromMessages(messages);

    expect(displayMessages).toHaveLength(2);
    expect(displayMessages[0]).toEqual({
      role: "user",
      text: "How many files are here?",
    });
    expect(displayMessages[1]).toEqual({
      role: "assistant",
      text: "I will check.\nDone.",
      toolCalls: [
        {
          toolUseId: "tool-1",
          toolName: "Bash",
          input: { command: "ls" },
          result: "src\ntests",
          isError: false,
          status: "done",
        },
      ],
    });
  });

  test("resume session collapses @file-expanded user messages into attachment summary", () => {
    const prepared = prepareUserPrompt("Review @src/index.ts", { cwd: process.cwd() });
    const messages: ChatMessage[] = [
      { role: "user", content: prepared.messageText },
    ];

    const displayMessages = buildDisplayMessagesFromMessages(messages);

    expect(displayMessages).toHaveLength(1);
    expect(displayMessages[0]).toEqual({
      role: "user",
      text: "Review\n[Attached: src/index.ts]",
    });
  });
});
