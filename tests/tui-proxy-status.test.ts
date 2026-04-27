import { describe, expect, test } from "bun:test";
import type React from "react";
import { App } from "../src/tui/app.js";
import { REPL } from "../src/tui/repl.js";
import { createAppState } from "../src/agent/context.js";
import { formatProxyStatusLabel, type ProxyStatus } from "../src/tui/status-bar.js";
import { formatAgentStatusLabel } from "../src/agent/status.js";
import type { LLMProvider } from "../src/providers/types.js";

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

describe("TUI proxy status", () => {
  test("formatProxyStatusLabel returns null when proxy is unused", () => {
    expect(formatProxyStatusLabel()).toBeNull();
  });

  test("formatProxyStatusLabel renders online proxy details", () => {
    const proxyStatus: ProxyStatus = {
      url: "http://127.0.0.1:4317",
      providerCount: 8,
      isListening: true,
    };

    expect(formatProxyStatusLabel(proxyStatus)).toBe("http://127.0.0.1:4317 (8 providers)");
  });

  test("formatProxyStatusLabel renders offline state", () => {
    const proxyStatus: ProxyStatus = {
      url: "http://127.0.0.1:4317",
      providerCount: 0,
      isListening: false,
    };

    expect(formatProxyStatusLabel(proxyStatus)).toBe("offline");
  });

  test("formatAgentStatusLabel renders compact agent status", () => {
    expect(formatAgentStatusLabel({ mode: "goal", status: "planning" })).toBe("goal:planning");
  });

  test("App forwards proxyStatus to REPL", () => {
    const provider = createMockProvider();
    const state = createAppState({ cwd: process.cwd(), provider, tools: [] });
    const proxyStatus: ProxyStatus = {
      url: "http://127.0.0.1:4317",
      providerCount: 2,
      isListening: true,
    };

    const element = App({
      state,
      systemPrompt: "system prompt",
      maxTurns: 5,
      proxyStatus,
    }) as React.ReactElement;

    expect(element.type).toBe(REPL);
    expect(element.props.proxyStatus).toEqual(proxyStatus);
  });
});
