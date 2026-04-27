/**
 * Phase 9 (A2) — Prompt Library Evidence tests.
 * Covers registerPromptWithMetadata, recordPromptUse, searchPromptEvidence,
 * and legacy/corrupt JSON resilience.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPrompts,
  recordPromptUse,
  registerPromptWithMetadata,
  savePrompt,
  type PromptSnippet,
} from "../src/prompt/library.js";
import { readEvidence } from "../src/agent/self-improve/evidence.js";
import { searchPromptEvidence } from "../src/agent/self-improve/prompt-evidence-search.js";
import type { EvidenceRecord } from "../src/agent/self-improve/types.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const PROJECT_ID = "phase9-test-project";

describe("Phase 9 · prompt library metadata & evidence", () => {
  test("TC-9.1 registerPromptWithMetadata persists tier/owner/tags in JSON", () => {
    const dir = tempDir("p9-reg-");
    try {
      const snippet = registerPromptWithMetadata({
        name: "refactor-helper",
        text: "Refactor the target module.",
        tier: "recall",
        owner: "alice",
        tags: ["refactor", "cleanup"],
        criticalRequirements: ["preserve public API"],
        dir,
      });

      expect(snippet.tier).toBe("recall");
      expect(snippet.owner).toBe("alice");
      expect(snippet.registeredAt).toBeDefined();

      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const raw = readFileSync(join(dir, files[0]!), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.tier).toBe("recall");
      expect(parsed.owner).toBe("alice");
      expect(parsed.tags).toEqual(["refactor", "cleanup"]);
      expect(parsed.criticalRequirements).toEqual(["preserve public API"]);
      expect(typeof parsed.registeredAt).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TC-9.2 recordPromptUse appends one evidence line per call", () => {
    const root = tempDir("p9-ev-");
    try {
      for (let i = 0; i < 5; i++) {
        recordPromptUse({
          projectId: PROJECT_ID,
          promptName: "refactor-helper",
          sessionId: `sess-${i}`,
          outcome: { success: true, accuracy: 90 + i },
          rootDir: root,
        });
      }

      const records = readEvidence(PROJECT_ID, "prompt", "refactor-helper", {}, root);
      expect(records).toHaveLength(5);
      expect(records.map((r) => r.iteration)).toEqual([1, 2, 3, 4, 5]);
      for (const r of records) {
        expect(r.domain).toBe("prompt");
        expect(r.id).toBe("refactor-helper");
        expect(r.outcome.success).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-9.3 searchPromptEvidence ranks records by containment + recency", () => {
    const now = Date.now();
    const mk = (id: string, title: string, ageDays: number): EvidenceRecord => ({
      domain: "prompt",
      id,
      sessionId: "s",
      iteration: 1,
      invokedAt: new Date(now - ageDays * 86_400_000).toISOString(),
      outcome: { success: true },
      metadata: { title },
    });

    const records: EvidenceRecord[] = [
      mk("rec-a", "Refactor database helper", 1),
      mk("rec-b", "Refactor auth module", 30),
      mk("rec-c", "Add analytics dashboard", 5),
    ];

    const hits = searchPromptEvidence({
      records,
      query: "refactor database",
      timeRangeDays: 90,
      minSimilarity: 0.3,
      maxResults: 5,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.record.id).toBe("rec-a");
    // "Add analytics dashboard" has no overlapping tokens with "refactor database" → filtered.
    expect(hits.some((h) => h.record.id === "rec-c")).toBe(false);

    // All hits should be sorted by score desc.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }

    // Age filter drops records beyond timeRangeDays.
    const recentOnly = searchPromptEvidence({
      records,
      query: "refactor",
      timeRangeDays: 7,
      minSimilarity: 0.3,
    });
    expect(recentOnly.every((h) => h.ageDays <= 7)).toBe(true);
    expect(recentOnly.some((h) => h.record.id === "rec-b")).toBe(false);
  });

  test("TC-9.4 consumer decides when to record — registeredAt gating", () => {
    const dir = tempDir("p9-gate-");
    const root = tempDir("p9-gate-ev-");
    try {
      // Legacy prompt: no registeredAt.
      const legacy = savePrompt(
        { name: "legacy", text: "Legacy text." },
        { dir },
      );
      expect(legacy.registeredAt).toBeUndefined();

      // Metadata prompt.
      const modern = registerPromptWithMetadata({
        name: "modern",
        text: "Modern text.",
        tier: "core",
        dir,
      });
      expect(modern.registeredAt).toBeDefined();

      // Caller-discipline: only record when registeredAt is present.
      const shouldRecord = (snippet: PromptSnippet): boolean =>
        typeof snippet.registeredAt === "string";

      if (shouldRecord(legacy)) {
        recordPromptUse({
          projectId: PROJECT_ID,
          promptName: legacy.name,
          sessionId: "s",
          outcome: { success: true },
          rootDir: root,
        });
      }
      if (shouldRecord(modern)) {
        recordPromptUse({
          projectId: PROJECT_ID,
          promptName: modern.name,
          sessionId: "s",
          outcome: { success: true },
          rootDir: root,
        });
      }

      expect(readEvidence(PROJECT_ID, "prompt", "legacy", {}, root)).toHaveLength(0);
      expect(readEvidence(PROJECT_ID, "prompt", "modern", {}, root)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-9.5 legacy prompts without new fields load without error", () => {
    const dir = tempDir("p9-legacy-");
    try {
      // Write a legacy-shaped JSON file directly.
      writeFileSync(
        join(dir, "legacy-1.json"),
        JSON.stringify({
          id: "legacy-1",
          name: "legacy-one",
          text: "Hello.",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        "utf-8",
      );

      const prompts = loadPrompts({ dir });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.id).toBe("legacy-1");
      expect(prompts[0]!.tier).toBeUndefined();
      expect(prompts[0]!.registeredAt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TC-9.E1 corrupt JSON prompt files are skipped, not thrown", () => {
    const dir = tempDir("p9-corrupt-");
    try {
      writeFileSync(join(dir, "bad.json"), "{ not valid json", "utf-8");
      const good = registerPromptWithMetadata({
        name: "good",
        text: "Good text.",
        dir,
      });

      const prompts = loadPrompts({ dir });
      expect(prompts.map((p) => p.id)).toEqual([good.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
