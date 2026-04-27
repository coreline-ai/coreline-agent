import { describe, expect, test } from "bun:test";
import { hashChatMessage, getSnipTurnIndex, applySnips, SnipRegistry, type ChatMessage, type SnipMarker } from "../src/agent/context-snip.js";

function makeMessages(): ChatMessage[] {
  return [
    { role: "user", content: "Plan the scaffold." },
    { role: "assistant", content: [{ type: "text", text: "I will scaffold the tool." }] },
    { role: "user", content: "Add tests too." },
    { role: "assistant", content: [{ type: "text", text: "Added tests." }] },
    { role: "user", content: "Keep the last exchange." },
    { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    { role: "user", content: "Do not touch this tail." },
  ];
}

function makeMarker(
  messages: ChatMessage[],
  startIndex: number,
  endIndex: number,
  overrides: Partial<SnipMarker> = {},
): SnipMarker {
  return {
    id: overrides.id ?? `marker-${startIndex}-${endIndex}-${overrides.priority ?? 0}`,
    startIndex,
    endIndex,
    startTurn: getSnipTurnIndex(messages, startIndex),
    endTurn: getSnipTurnIndex(messages, endIndex),
    startContentHash: hashChatMessage(messages[startIndex]!),
    endContentHash: hashChatMessage(messages[endIndex]!),
    createdAt: overrides.createdAt ?? "2026-04-20T20:14:55.000Z",
    priority: overrides.priority ?? 0,
    summary: overrides.summary,
    reason: overrides.reason,
  };
}

describe("context snip", () => {
  test("caps registry markers at 100 and drops the oldest low-priority entry", () => {
    const registry = new SnipRegistry();

    for (let i = 0; i < 101; i += 1) {
      registry.add({
        id: `marker-${i}`,
        startIndex: 0,
        endIndex: 1,
        startTurn: 0,
        endTurn: 1,
        startContentHash: `start-${i}`,
        endContentHash: `end-${i}`,
        createdAt: new Date(Date.UTC(2026, 3, 20, 20, 0, i)).toISOString(),
        priority: 1,
      });
    }

    expect(registry.size()).toBe(100);
    expect(registry.get("marker-0")).toBeUndefined();
    expect(registry.get("marker-100")).toBeDefined();
  });

  test("applies the highest-priority overlapping marker", () => {
    const messages = makeMessages();
    const low = makeMarker(messages, 0, 1, { id: "low", priority: 1, summary: "low priority summary" });
    const high = makeMarker(messages, 0, 1, { id: "high", priority: 10, summary: "high priority summary" });

    const result = applySnips(messages, [low, high], { maxTokens: 100_000 }, { protectRecentMessages: 2 });

    expect(result.compacted).toBe(true);
    expect(result.appliedMarkerCount).toBe(1);
    expect(result.summaryCount).toBe(1);
    expect(result.messages[0]!.content).toContain("high priority summary");
    expect(result.messages[0]!.content).not.toContain("low priority summary");
  });

  test("skips mismatched markers and keeps the valid marker", () => {
    const messages = makeMessages();
    const valid = makeMarker(messages, 0, 1, { id: "valid", priority: 1, summary: "valid summary" });
    const invalid: SnipMarker = {
      ...makeMarker(messages, 0, 1, { id: "invalid", priority: 20, summary: "invalid summary" }),
      endContentHash: "definitely-wrong",
    };

    const result = applySnips(messages, [invalid, valid], { maxTokens: 100_000 }, { protectRecentMessages: 2 });

    expect(result.compacted).toBe(true);
    expect(result.appliedMarkerCount).toBe(1);
    expect(result.summaryCount).toBe(1);
    expect(result.messages[0]!.content).toContain("valid summary");
    expect(result.messages[0]!.content).not.toContain("invalid summary");
  });

  test("inserts a summary message for the removed range", () => {
    const messages = makeMessages();
    const marker = makeMarker(messages, 0, 3, { id: "summary", priority: 5, summary: "Context Snip QA" });

    const result = applySnips(messages, [marker], { maxTokens: 100_000 }, { protectRecentMessages: 2 });

    expect(result.compacted).toBe(true);
    expect(result.appliedMarkerCount).toBe(1);
    expect(result.droppedCount).toBe(4);
    expect(result.summaryCount).toBe(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(typeof result.messages[0]!.content).toBe("string");
    expect(result.messages[0]!.content).toContain("[Context snip summary:");
    expect(result.messages[0]!.content).toContain("Context Snip QA");
    expect(result.messages.slice(1)).toEqual(messages.slice(4));
  });

  test("protects recent messages from snipping", () => {
    const messages = makeMessages();
    const marker = makeMarker(messages, 5, 6, { id: "tail", priority: 10, summary: "tail summary" });

    const result = applySnips(messages, [marker], { maxTokens: 100_000 }, { protectRecentMessages: 4 });

    expect(result.compacted).toBe(false);
    expect(result.appliedMarkerCount).toBe(0);
    expect(result.droppedCount).toBe(0);
    expect(result.summaryCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test("returns the original messages unchanged when no markers are provided", () => {
    const messages = makeMessages();

    const result = applySnips(messages, [], { maxTokens: 100_000 });

    expect(result).toEqual({
      messages,
      appliedMarkerCount: 0,
      droppedCount: 0,
      compacted: false,
      summaryCount: 0,
    });
  });
});
