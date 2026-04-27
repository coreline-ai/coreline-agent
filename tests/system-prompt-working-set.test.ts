/**
 * Phase 2 — buildSystemPrompt integrates working-set selector (Memory section).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { GlobalUserMemory } from "../src/memory/global-user-memory.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkTmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function seed(
  mem: ProjectMemory,
  name: string,
  overrides: Partial<MemoryEntry> = {},
): void {
  mem.writeEntry({
    name,
    description: overrides.description ?? `desc ${name}`,
    type: overrides.type ?? "user",
    body: overrides.body ?? `body ${name}`,
    filePath: "",
    ...overrides,
  });
}

function daysAgoIso(daysAgo: number): string {
  const base = new Date("2026-04-20T00:00:00Z");
  const d = new Date(base.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function seedMemories(mem: ProjectMemory): void {
  // 3 core
  seed(mem, "core1", { tier: "core", lastAccessed: daysAgoIso(0) });
  seed(mem, "core2", { tier: "core", lastAccessed: daysAgoIso(1) });
  seed(mem, "core3", { tier: "core", lastAccessed: daysAgoIso(2) });
  // 5 recall (the top 5 slots remain after 3 core in default limit 8)
  for (let i = 0; i < 5; i++) {
    seed(mem, `recall${i}`, {
      tier: "recall",
      lastAccessed: daysAgoIso(5 + i),
    });
  }
  // 2 archival
  seed(mem, "arch1", { tier: "archival", lastAccessed: daysAgoIso(30) });
  seed(mem, "arch2", { tier: "archival", lastAccessed: daysAgoIso(40) });
}

describe("system-prompt-working-set / Memory section", () => {
  const prevDebug = process.env.CORELINE_DEBUG_PROMPT;
  const prevLimit = process.env.CORELINE_WORKING_SET_LIMIT;

  beforeEach(() => {
    delete process.env.CORELINE_DEBUG_PROMPT;
    delete process.env.CORELINE_WORKING_SET_LIMIT;
  });

  afterEach(() => {
    if (prevDebug === undefined) delete process.env.CORELINE_DEBUG_PROMPT;
    else process.env.CORELINE_DEBUG_PROMPT = prevDebug;
    if (prevLimit === undefined) delete process.env.CORELINE_WORKING_SET_LIMIT;
    else process.env.CORELINE_WORKING_SET_LIMIT = prevLimit;
  });

  test("contains core names + top recall names, excludes archival", () => {
    const root = mkTmpRoot("memkraft-sp-ws");
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-sp-1", { rootDir: root });
      seedMemories(mem);

      const prompt = buildSystemPrompt("/tmp/fake-cwd-sp-1", [], mem);

      // Core names present
      expect(prompt).toContain("- core1: desc core1");
      expect(prompt).toContain("- core2: desc core2");
      expect(prompt).toContain("- core3: desc core3");
      // Top recall names present (5 recall fill remaining 5 slots with default limit 8)
      expect(prompt).toContain("- recall0: desc recall0");
      expect(prompt).toContain("- recall4: desc recall4");
      // Archival not injected
      expect(prompt).not.toContain("- arch1:");
      expect(prompt).not.toContain("- arch2:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("globalMemory section is byte-identical before/after working-set injection", () => {
    const root = mkTmpRoot("memkraft-sp-ws-global");
    const globalRoot = mkTmpRoot("memkraft-sp-ws-global-mem");
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-sp-2", { rootDir: root });
      const globalMem = new GlobalUserMemory(globalRoot);
      globalMem.writeEntry({
        name: "pref1",
        type: "preference",
        description: "global pref desc",
        body: "global pref body",
        createdAt: "2026-04-01",
        provenance: { source: "manual" },
      });

      const promptEmpty = buildSystemPrompt(
        "/tmp/fake-cwd-sp-2",
        [],
        mem,
        undefined,
        undefined,
        { globalMemory: globalMem },
      );

      seedMemories(mem);

      const promptAfter = buildSystemPrompt(
        "/tmp/fake-cwd-sp-2",
        [],
        mem,
        undefined,
        undefined,
        { globalMemory: globalMem },
      );

      const marker = "# Global User Memory";
      const extract = (s: string): string => {
        const idx = s.indexOf(marker);
        expect(idx).toBeGreaterThanOrEqual(0);
        // Terminate at next top-level section or end.
        const after = s.slice(idx);
        // End at next "\n#" heading (excluding current).
        const nextHeadingRel = after.slice(1).search(/\n# /);
        return nextHeadingRel >= 0 ? after.slice(0, nextHeadingRel + 1) : after;
      };

      expect(extract(promptAfter)).toBe(extract(promptEmpty));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });

  test("CORELINE_DEBUG_PROMPT=1 → output contains working_set debug comment", () => {
    const root = mkTmpRoot("memkraft-sp-ws-debug");
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-sp-3", { rootDir: root });
      seedMemories(mem);

      process.env.CORELINE_DEBUG_PROMPT = "1";
      const prompt = buildSystemPrompt("/tmp/fake-cwd-sp-3", [], mem);

      expect(prompt).toContain("<!-- working_set: core=3, recall=5, archived=2, omitted=0 -->");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without CORELINE_DEBUG_PROMPT, no debug comment", () => {
    const root = mkTmpRoot("memkraft-sp-ws-nodebug");
    try {
      const mem = new ProjectMemory("/tmp/fake-cwd-sp-4", { rootDir: root });
      seedMemories(mem);

      const prompt = buildSystemPrompt("/tmp/fake-cwd-sp-4", [], mem);
      expect(prompt).not.toContain("working_set:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
