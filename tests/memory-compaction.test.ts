/**
 * Phase 6 (B4) — Memory compaction tests.
 *
 * Rules exercised:
 *  1. daysOld > 90 AND tier !== core → archival
 *  2. importance === low AND daysOld > 30 → archival
 *  3. total_chars > maxChars AND tier === recall AND daysOld > 30 → archival (oldest first)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compact } from "../src/memory/compaction.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { tierOf } from "../src/memory/tiering.js";
import type { MemoryEntry } from "../src/memory/types.js";

function isoDaysAgo(days: number): string {
  const now = Date.now();
  const target = new Date(now - days * 86_400_000);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, "0");
  const d = String(target.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function makeEntry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "name">): MemoryEntry {
  return {
    name: partial.name,
    description: partial.description ?? `desc for ${partial.name}`,
    type: partial.type ?? "project",
    body: partial.body ?? `body for ${partial.name}`,
    filePath: partial.filePath ?? "",
    tier: partial.tier,
    lastAccessed: partial.lastAccessed,
    accessCount: partial.accessCount,
    importance: partial.importance,
  };
}

describe("Memory compaction (Phase 6)", () => {
  let rootDir: string;
  let workspace: string;
  let projectMemory: ProjectMemory;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "compact-test-"));
    workspace = mkdtempSync(join(tmpdir(), "compact-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    projectMemory = new ProjectMemory(workspace, { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // TC-6.1: 100-day-old recall → archival.
  test("TC-6.1: 100-day-old recall is archived (rule 1)", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "old_recall",
        tier: "recall",
        lastAccessed: isoDaysAgo(100),
      }),
    );

    const result = compact({ projectMemory });

    expect(result.moved).toBe(1);
    expect(result.movedNames).toContain("old_recall");
    expect(result.dryRun).toBe(false);
    expect(tierOf(projectMemory, "old_recall")).toBe("archival");
  });

  // TC-6.2: 100-day-old core → preserved (rule 1 bypass).
  test("TC-6.2: 100-day-old core is preserved (rule 1 bypass)", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "old_core",
        tier: "core",
        lastAccessed: isoDaysAgo(100),
      }),
    );

    const result = compact({ projectMemory });

    expect(result.moved).toBe(0);
    expect(tierOf(projectMemory, "old_core")).toBe("core");
  });

  // TC-6.3: 35-day-old importance=low → archival (rule 2).
  test("TC-6.3: 35-day-old importance:low is archived (rule 2)", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "stale_low",
        tier: "recall",
        importance: "low",
        lastAccessed: isoDaysAgo(35),
      }),
    );
    // Control: same age but importance=medium — should stay.
    projectMemory.writeEntry(
      makeEntry({
        name: "stale_medium",
        tier: "recall",
        importance: "medium",
        lastAccessed: isoDaysAgo(35),
      }),
    );

    const result = compact({ projectMemory });

    expect(result.movedNames).toContain("stale_low");
    expect(result.movedNames).not.toContain("stale_medium");
    expect(tierOf(projectMemory, "stale_low")).toBe("archival");
    expect(tierOf(projectMemory, "stale_medium")).toBe("recall");
  });

  // TC-6.4: Many recall entries pushing total over maxChars → oldest recall archived (rule 3).
  test("TC-6.4: overflow evicts oldest recall entries (rule 3)", () => {
    const bigBody = "x".repeat(1000);

    // 5 recall entries each ~1000 chars; ages 40/50/60/70/80 days.
    // All are >30 days old → eligible for rule 3.
    const ages = [40, 50, 60, 70, 80];
    for (let i = 0; i < ages.length; i += 1) {
      projectMemory.writeEntry(
        makeEntry({
          name: `bulk_${i}`,
          tier: "recall",
          body: bigBody,
          lastAccessed: isoDaysAgo(ages[i]!),
        }),
      );
    }

    // maxChars 2500 → must archive enough to drop below. Oldest (80d) first.
    const result = compact({ projectMemory, maxChars: 2500 });

    expect(result.moved).toBeGreaterThan(0);
    // Oldest must be archived.
    expect(tierOf(projectMemory, "bulk_4")).toBe("archival"); // 80d
    // Newest (40d) should still fit and remain recall.
    expect(tierOf(projectMemory, "bulk_0")).toBe("recall");
  });

  // TC-6.5: All recent → no changes.
  test("TC-6.5: all recent entries → moved:0", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "fresh1",
        tier: "recall",
        lastAccessed: isoDaysAgo(5),
      }),
    );
    projectMemory.writeEntry(
      makeEntry({
        name: "fresh2",
        tier: "recall",
        lastAccessed: isoDaysAgo(10),
        importance: "low",
      }),
    );

    const result = compact({ projectMemory });

    expect(result.moved).toBe(0);
    expect(result.movedNames).toEqual([]);
    expect(result.freedChars).toBe(0);
    expect(tierOf(projectMemory, "fresh1")).toBe("recall");
    expect(tierOf(projectMemory, "fresh2")).toBe("recall");
  });

  // TC-6.6: dryRun → counts returned, disk unchanged.
  test("TC-6.6: dryRun reports moves but leaves disk unchanged", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "old_recall",
        tier: "recall",
        lastAccessed: isoDaysAgo(100),
        body: "hello world",
        description: "short desc",
      }),
    );

    const result = compact({ projectMemory, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.moved).toBe(1);
    expect(result.movedNames).toContain("old_recall");
    expect(result.freedChars).toBe("hello world".length + "short desc".length);
    // Tier unchanged on disk.
    expect(tierOf(projectMemory, "old_recall")).toBe("recall");
  });

  // TC-6.E1: No lastAccessed + unreadable mtime → skipped gracefully.
  test("TC-6.E1: entry with no lastAccessed and no accessible mtime is skipped", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "ghost",
        tier: "recall",
      }),
    );
    // Read back so we know the file path, then simulate "no mtime" by
    // pointing filePath at a non-existent file via a manual entry read-patch:
    // easier approach — rewrite entry with a bogus filePath is not possible
    // (ProjectMemory controls filePath). Instead we delete the underlying file
    // so statSync throws, while keeping index.
    const stored = projectMemory.readEntry("ghost");
    expect(stored).not.toBeNull();
    if (!stored) return;

    // Remove the backing file; listEntries() pulls from index JSON comments
    // when available, so the entry may still be listed even though the file
    // is gone — readEntry will return null in that case. Our code handles
    // that by skipping (entry is not in the loaded list at all → no archive).
    rmSync(stored.filePath);

    const result = compact({ projectMemory });

    // Entry is unreadable → loadAllEntries drops it → no archive, no error.
    expect(result.moved).toBe(0);
    expect(result.movedNames).toEqual([]);
  });

  // Additional robustness: mtime fallback works when lastAccessed absent.
  test("mtime fallback archives ancient file lacking lastAccessed", () => {
    projectMemory.writeEntry(
      makeEntry({
        name: "mtime_old",
        tier: "recall",
      }),
    );

    const stored = projectMemory.readEntry("mtime_old");
    expect(stored).not.toBeNull();
    if (!stored) return;

    // Backdate mtime by 120 days.
    const oldTs = (Date.now() - 120 * 86_400_000) / 1000;
    utimesSync(stored.filePath, oldTs, oldTs);

    const result = compact({ projectMemory });

    expect(result.moved).toBe(1);
    expect(tierOf(projectMemory, "mtime_old")).toBe("archival");
  });
});
