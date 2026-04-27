/**
 * Phase D/E/F tests — context management, retry, slash commands.
 */

import { describe, test, expect } from "bun:test";
import { estimateTokens, estimateMessageTokens, estimateTotalTokens } from "../src/utils/token-estimator.js";
import { truncateToolOutput, trimToContextWindow, compactMessages } from "../src/agent/context-manager.js";
import { withRetry } from "../src/agent/retry.js";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import type { ChatMessage } from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// Phase D: Token estimation
// ---------------------------------------------------------------------------

describe("Token Estimator", () => {
  test("estimates English text (~3.5 chars/token)", () => {
    const tokens = estimateTokens("Hello, world! This is a test.");
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(15);
  });

  test("estimates CJK text (~1.5 chars/token)", () => {
    const tokens = estimateTokens("안녕하세요 세계");
    expect(tokens).toBeGreaterThan(3);
  });

  test("estimates message tokens with overhead", () => {
    const msg: ChatMessage = { role: "user", content: "Hello" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(4); // overhead + content
  });

  test("estimates total tokens across messages", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    ];
    const total = estimateTotalTokens(msgs);
    expect(total).toBeGreaterThan(8);
  });
});

// ---------------------------------------------------------------------------
// Phase D: Tool output truncation
// ---------------------------------------------------------------------------

describe("Tool Output Truncation", () => {
  test("short output unchanged", () => {
    const result = truncateToolOutput("hello", 1000);
    expect(result).toBe("hello");
  });

  test("long output truncated with suffix", () => {
    const longStr = "x".repeat(200);
    const result = truncateToolOutput(longStr, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("[Output truncated");
  });
});

// ---------------------------------------------------------------------------
// Phase D: Context window management
// ---------------------------------------------------------------------------

describe("Context Window Management", () => {
  const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `Message ${i}: ${"a".repeat(100)}`,
  }));

  test("trimToContextWindow keeps recent messages", () => {
    const trimmed = trimToContextWindow(msgs, 100, { maxTokens: 500, reservedForResponse: 100 });
    expect(trimmed.length).toBeLessThan(msgs.length);
    expect(trimmed.length).toBeGreaterThan(0);
    // Last message should always be included
    expect(trimmed[trimmed.length - 1]).toBe(msgs[msgs.length - 1]);
  });

  test("compactMessages creates summary when over budget", () => {
    const result = compactMessages(msgs, 100, { maxTokens: 500, reservedForResponse: 100 });
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.messages[0]!.content).toContain("summary");
  });

  test("compactMessages no-op when within budget", () => {
    const shortMsgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const result = compactMessages(shortMsgs, 100, { maxTokens: 100000, reservedForResponse: 8192 });
    expect(result.compacted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase E: Retry logic
// ---------------------------------------------------------------------------

describe("Retry Logic", () => {
  test("succeeds on first try", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries on retryable error", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("fetch failed");
        return "recovered";
      },
      { maxRetries: 3, initialDelayMs: 10 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("does not retry non-retryable error", async () => {
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          throw new Error("401 unauthorized");
        },
        { maxRetries: 3, initialDelayMs: 10 },
      );
    } catch (err) {
      expect((err as Error).message).toContain("401");
    }
    expect(calls).toBe(1); // no retry for auth errors
  });

  test("exhausts retries and throws", async () => {
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          throw new Error("503 overloaded");
        },
        { maxRetries: 2, initialDelayMs: 10 },
      );
    } catch (err) {
      expect((err as Error).message).toContain("503");
    }
    expect(calls).toBe(3); // initial + 2 retries
  });
});

// ---------------------------------------------------------------------------
// Phase F: Slash commands
// ---------------------------------------------------------------------------

describe("Slash Commands", () => {
  test("/help returns help text", () => {
    const result = handleSlashCommand("/help");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("/clear");
    expect(result.output).toContain("/compact");
    expect(result.output).toContain("/exit");
  });

  test("/clear triggers clear action", () => {
    const result = handleSlashCommand("/clear");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("clear");
  });

  test("/exit triggers exit action", () => {
    const result = handleSlashCommand("/exit");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("exit");
  });

  test("/quit triggers exit action", () => {
    const result = handleSlashCommand("/quit");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("exit");
  });

  test("/compact triggers compact action", () => {
    const result = handleSlashCommand("/compact");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("compact");
  });

  test("/model returns model placeholder", () => {
    const result = handleSlashCommand("/model");
    expect(result.handled).toBe(true);
    expect(result.output).toBeDefined();
  });

  test("/provider with arg triggers switch", () => {
    const result = handleSlashCommand("/provider claude");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("switch_provider");
    expect(result.data).toBe("claude");
  });

  test("/provider without arg shows info", () => {
    const result = handleSlashCommand("/provider");
    expect(result.handled).toBe(true);
    expect(result.action).toBeUndefined();
  });

  test("role, prompt, search, and replay slash commands route to actions", () => {
    expect(handleSlashCommand("/role reviewer")).toEqual({
      handled: true,
      action: "role",
      data: "reviewer",
    });
    expect(handleSlashCommand("/prompt save review note")).toEqual({
      handled: true,
      action: "prompt_save",
      data: "review note",
    });
    expect(handleSlashCommand("/prompt list")).toEqual({
      handled: true,
      action: "prompt_list",
    });
    expect(handleSlashCommand("/prompt use review note")).toEqual({
      handled: true,
      action: "prompt_use",
      data: "review note",
    });
    expect(handleSlashCommand("/prompt delete review note")).toEqual({
      handled: true,
      action: "prompt_delete",
      data: "review note",
    });
    expect(handleSlashCommand("/search provider bug")).toEqual({
      handled: true,
      action: "search",
      data: "provider bug",
    });
    expect(handleSlashCommand("/replay session-1")).toEqual({
      handled: true,
      action: "replay",
      data: "session-1",
    });
  });

  test("unknown slash command returns error", () => {
    const result = handleSlashCommand("/nonexistent");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("Unknown command");
  });

  test("non-slash input returns not handled", () => {
    const result = handleSlashCommand("hello world");
    expect(result.handled).toBe(false);
  });

  test("/h is alias for /help", () => {
    const result = handleSlashCommand("/h");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("/clear");
  });
});
