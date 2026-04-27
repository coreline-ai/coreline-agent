/**
 * Phase 4 (B6) — Auto-summary tiering tests.
 *
 * Verifies:
 *  - buildAutoSummaryEntry stamps tier/importance/lastAccessed/accessCount.
 *  - maybeWriteAutoSummary preserves user-customised tier across re-writes.
 *  - Legacy tier-less entries are upgraded on next auto-summary run.
 *  - defaultTierForType falls back to DEFAULT_TIER for unknown types.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage } from "../src/agent/types.js";
import type { MemoryEntry, MemoryType } from "../src/memory/types.js";
import {
  buildAutoSummaryEntry,
  maybeWriteAutoSummary,
  AUTO_SUMMARY_ENTRY_NAME,
} from "../src/memory/auto-summary.js";
import { defaultTierForType, todayIso } from "../src/memory/tiering.js";
import { DEFAULT_TIER } from "../src/memory/constants.js";
import { ProjectMemory } from "../src/memory/project-memory.js";

const SYSTEM_PROMPT = "You are helpful.";

function makeConversation(): ChatMessage[] {
  return [
    {
      role: "user",
      content:
        "Remember to always prefer Bun as the default runtime, and use the local proxy for MCP workflows.",
    },
    {
      role: "assistant",
      content:
        "Understood. I will always prefer Bun as the default runtime and use the local proxy for MCP workflows from now on.",
    },
  ];
}

describe("Auto-summary tiering (Phase 4)", () => {
  let rootDir: string;
  let workspace: string;
  let projectMemory: ProjectMemory;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "auto-summary-test-"));
    workspace = mkdtempSync(join(tmpdir(), "auto-summary-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, "AGENT.md"), "# Rules\nPrefer Bun.");
    projectMemory = new ProjectMemory(workspace, { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TC-4.1: feedback type default tier is "core".
  // Auto-summary itself writes project-typed entries — so we also exercise
  // defaultTierForType directly, plus verify the written entry carries a tier
  // consistent with defaultTierForType.
  // -------------------------------------------------------------------------
  test("TC-4.1: feedback-typed memory defaults to core tier", () => {
    expect(defaultTierForType("feedback")).toBe("core");

    // Write a feedback entry manually and ensure auto-summary preserves its
    // existing tier (which for feedback defaults to "core" in practice).
    projectMemory.writeEntry({
      name: "feedback_sample",
      description: "user feedback sample",
      type: "feedback",
      body: "Use Bun, not node.",
      filePath: "",
      tier: defaultTierForType("feedback"),
    });

    const stored = projectMemory.readEntry("feedback_sample");
    expect(stored?.tier).toBe("core");
  });

  // -------------------------------------------------------------------------
  // TC-4.2: reference type default tier is "recall".
  // -------------------------------------------------------------------------
  test("TC-4.2: reference-typed memory defaults to recall tier", () => {
    expect(defaultTierForType("reference")).toBe("recall");

    projectMemory.writeEntry({
      name: "reference_sample",
      description: "reference doc",
      type: "reference",
      body: "See docs/foo.md for details.",
      filePath: "",
      tier: defaultTierForType("reference"),
    });

    const stored = projectMemory.readEntry("reference_sample");
    expect(stored?.tier).toBe("recall");
  });

  // -------------------------------------------------------------------------
  // TC-4.3: User manually sets tier=archival; subsequent auto-summary run
  // must preserve the archival decision.
  // -------------------------------------------------------------------------
  test("TC-4.3: preserves user-set archival tier on re-write", () => {
    // Seed an existing auto_summary entry manually pinned to archival.
    projectMemory.writeEntry({
      name: AUTO_SUMMARY_ENTRY_NAME,
      description: "Previously archived auto-summary",
      type: "project",
      body: "# Old body",
      filePath: "",
      tier: "archival",
      importance: "low",
    });

    const result = maybeWriteAutoSummary({
      projectMemory,
      messages: makeConversation(),
      systemPrompt: SYSTEM_PROMPT,
      agentDepth: 0,
      enabled: true,
    });

    expect(result.written).toBe(true);
    const after = projectMemory.readEntry(AUTO_SUMMARY_ENTRY_NAME);
    expect(after).not.toBeNull();
    expect(after?.tier).toBe("archival");
    // importance preserved too (spec: preserve user-customised importance).
    expect(after?.importance).toBe("low");
    // lastAccessed should be refreshed to today.
    expect(after?.lastAccessed).toBe(todayIso());
  });

  // -------------------------------------------------------------------------
  // TC-4.4: Legacy entry with no tier → next auto-summary run assigns tier
  // via defaultTierForType (project → core).
  // -------------------------------------------------------------------------
  test("TC-4.4: legacy tier-less entry gets default tier on next run", () => {
    // Seed a legacy entry lacking tier/importance fields.
    projectMemory.writeEntry({
      name: AUTO_SUMMARY_ENTRY_NAME,
      description: "Legacy auto-summary",
      type: "project",
      body: "# Legacy body (will be replaced)",
      filePath: "",
    });

    const preLegacy = projectMemory.readEntry(AUTO_SUMMARY_ENTRY_NAME);
    expect(preLegacy).not.toBeNull();
    expect(preLegacy?.tier).toBeUndefined();

    const result = maybeWriteAutoSummary({
      projectMemory,
      messages: makeConversation(),
      systemPrompt: SYSTEM_PROMPT,
      agentDepth: 0,
      enabled: true,
    });

    expect(result.written).toBe(true);
    const after = projectMemory.readEntry(AUTO_SUMMARY_ENTRY_NAME);
    expect(after?.tier).toBe(defaultTierForType("project"));
    expect(after?.tier).toBe("core");
    expect(after?.importance).toBe("medium");
    expect(after?.lastAccessed).toBe(todayIso());
    expect(after?.accessCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // TC-4.E1: Unknown memory type → defaultTierForType falls back to
  // DEFAULT_TIER ("recall").
  // -------------------------------------------------------------------------
  test("TC-4.E1: unknown type falls back to DEFAULT_TIER", () => {
    const unknownType = "bogus-type" as unknown as MemoryType;
    expect(defaultTierForType(unknownType)).toBe(DEFAULT_TIER);
    expect(defaultTierForType(unknownType)).toBe("recall");
  });

  // -------------------------------------------------------------------------
  // Extra sanity: buildAutoSummaryEntry stamps the expected tiering fields
  // on the freshly constructed MemoryEntry.
  // -------------------------------------------------------------------------
  test("buildAutoSummaryEntry stamps tier/importance/lastAccessed/accessCount", () => {
    const entry: MemoryEntry | null = buildAutoSummaryEntry({
      messages: makeConversation(),
      systemPrompt: SYSTEM_PROMPT,
      agentDepth: 0,
    });

    expect(entry).not.toBeNull();
    if (!entry) return;
    expect(entry.type).toBe("project");
    expect(entry.tier).toBe(defaultTierForType("project"));
    expect(entry.tier).toBe("core");
    expect(entry.importance).toBe("medium");
    expect(entry.lastAccessed).toBe(todayIso());
    expect(entry.accessCount).toBe(1);
  });
});
