/**
 * Wave 7 Phase 2 — Reversible decay + tombstone tests.
 *
 * Exercises decayApply / decayList / decayRestore / decayRun / decayTombstone /
 * decayIsTombstoned across active + tombstoned states, including weight rounding
 * and collision suffixing on the tombstones directory.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decayApply,
  decayIsTombstoned,
  decayList,
  decayRestore,
  decayRun,
  decayTombstone,
} from "../src/memory/decay.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { getTombstonesDir } from "../src/config/paths.js";
import type { MemoryEntry } from "../src/memory/types.js";

let counter = 0;

function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "name">): MemoryEntry {
  return {
    name: overrides.name,
    description: overrides.description ?? `desc for ${overrides.name}`,
    type: overrides.type ?? "project",
    body: overrides.body ?? `body for ${overrides.name}`,
    filePath: overrides.filePath ?? "",
    ...overrides,
  };
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("Memory decay (Wave 7 Phase 2)", () => {
  let rootDir: string;
  let workspace: string;
  let projectMemory: ProjectMemory;

  beforeEach(() => {
    counter += 1;
    rootDir = mkdtempSync(join(tmpdir(), "decay-root-"));
    workspace = mkdtempSync(join(tmpdir(), `decay-ws-${counter}-`));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    projectMemory = new ProjectMemory(workspace, { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  // TC-2.1
  test("TC-2.1: decayApply rate 0.5 from weight 1.0 → 0.5", () => {
    projectMemory.writeEntry(makeEntry({ name: "alpha" }));

    const state = decayApply(projectMemory, "alpha", { decayRate: 0.5 });

    expect(state.decayWeight).toBe(0.5);
    expect(state.decayCount).toBe(1);
    expect(state.tombstoned).toBe(false);
    expect(state.lastAccessed).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const reread = projectMemory.readEntry("alpha");
    expect(reread?.decayWeight).toBe(0.5);
    expect(reread?.decayCount).toBe(1);
  });

  // TC-2.2
  test("TC-2.2: decayApply twice → weight 0.25, decayCount 2", () => {
    projectMemory.writeEntry(makeEntry({ name: "beta" }));
    decayApply(projectMemory, "beta", { decayRate: 0.5 });
    const state = decayApply(projectMemory, "beta", { decayRate: 0.5 });

    expect(state.decayWeight).toBe(0.25);
    expect(state.decayCount).toBe(2);
  });

  // TC-2.3
  test("TC-2.3: decayList belowThreshold 1.0 → only entries < 1.0", () => {
    projectMemory.writeEntry(makeEntry({ name: "fresh" }));
    projectMemory.writeEntry(makeEntry({ name: "decayed" }));
    decayApply(projectMemory, "decayed", { decayRate: 0.5 });

    const result = decayList(projectMemory, { belowThreshold: 1.0 });

    expect(result.map((s) => s.name).sort()).toEqual(["decayed"]);
    expect(result[0]?.decayWeight).toBe(0.5);
  });

  // TC-2.4
  test("TC-2.4: decayList includeTombstoned: true → includes tombstoned entries", () => {
    projectMemory.writeEntry(makeEntry({ name: "stillhere" }));
    projectMemory.writeEntry(makeEntry({ name: "byebye" }));
    decayTombstone(projectMemory, "byebye");

    const without = decayList(projectMemory, { belowThreshold: 1.0 });
    expect(without.map((s) => s.name)).not.toContain("byebye");

    const withTomb = decayList(projectMemory, { belowThreshold: 1.0, includeTombstoned: true });
    const names = withTomb.map((s) => s.name);
    expect(names).toContain("byebye");

    const tomb = withTomb.find((s) => s.name === "byebye");
    expect(tomb?.tombstoned).toBe(true);
    expect(tomb?.decayWeight).toBe(0);
  });

  // TC-2.5
  test("TC-2.5: decayTombstone → file moved, tombstoned=true", () => {
    projectMemory.writeEntry(makeEntry({ name: "doomed" }));
    const livePath = join(projectMemory.memoryDir, "doomed.md");
    expect(existsSync(livePath)).toBe(true);

    const state = decayTombstone(projectMemory, "doomed");

    expect(state.tombstoned).toBe(true);
    expect(state.tombstonedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(state.decayWeight).toBe(0);
    expect(existsSync(livePath)).toBe(false);

    const tombDir = getTombstonesDir(projectMemory.projectId, rootDir);
    expect(existsSync(join(tombDir, "doomed.md"))).toBe(true);

    // Index should no longer reference the entry.
    const remaining = projectMemory.listEntries().map((e) => e.name);
    expect(remaining).not.toContain("doomed");
  });

  // TC-2.6
  test("TC-2.6: decayRestore from tombstones → file moved back, fields reset", () => {
    projectMemory.writeEntry(makeEntry({ name: "phoenix" }));
    decayApply(projectMemory, "phoenix", { decayRate: 0.5 });
    decayTombstone(projectMemory, "phoenix");

    const tombDir = getTombstonesDir(projectMemory.projectId, rootDir);
    expect(existsSync(join(tombDir, "phoenix.md"))).toBe(true);

    const state = decayRestore(projectMemory, "phoenix");

    expect(state.decayWeight).toBe(1.0);
    expect(state.decayCount).toBe(0);
    expect(state.tombstoned).toBe(false);
    expect(existsSync(join(tombDir, "phoenix.md"))).toBe(false);

    const livePath = join(projectMemory.memoryDir, "phoenix.md");
    expect(existsSync(livePath)).toBe(true);

    const text = readFileSync(livePath, "utf-8");
    // Defaults must be omitted (byte-identical legacy format).
    expect(text).not.toContain("decayWeight:");
    expect(text).not.toContain("decayCount:");
    expect(text).not.toContain("tombstoned:");
  });

  // TC-2.7
  test("TC-2.7: decayRestore on active entry (not tombstoned) → just resets fields", () => {
    projectMemory.writeEntry(makeEntry({ name: "active" }));
    decayApply(projectMemory, "active", { decayRate: 0.5 });
    decayApply(projectMemory, "active", { decayRate: 0.5 });

    const before = projectMemory.readEntry("active");
    expect(before?.decayWeight).toBe(0.25);
    expect(before?.decayCount).toBe(2);

    const state = decayRestore(projectMemory, "active");
    expect(state.decayWeight).toBe(1.0);
    expect(state.decayCount).toBe(0);
    expect(state.tombstoned).toBe(false);

    const after = projectMemory.readEntry("active");
    expect(after?.decayWeight).toBeUndefined();
    expect(after?.decayCount).toBeUndefined();
  });

  // TC-2.8
  test("TC-2.8: decayRun with combined criteria (AND)", () => {
    // Entry A: old + low count + high weight (matches all)
    projectMemory.writeEntry(
      makeEntry({
        name: "stale_a",
        lastAccessed: isoDaysAgo(120),
        decayCount: 0,
        decayWeight: 0.9,
      }),
    );
    // Entry B: old but high count (fails accessCountLt)
    projectMemory.writeEntry(
      makeEntry({
        name: "stale_b",
        lastAccessed: isoDaysAgo(120),
        decayCount: 5,
        decayWeight: 0.9,
      }),
    );
    // Entry C: fresh (fails olderThanDays)
    projectMemory.writeEntry(
      makeEntry({
        name: "fresh_c",
        lastAccessed: isoDaysAgo(2),
        decayCount: 0,
        decayWeight: 0.9,
      }),
    );
    // Entry D: low weight (fails weightGt)
    projectMemory.writeEntry(
      makeEntry({
        name: "low_d",
        lastAccessed: isoDaysAgo(120),
        decayCount: 0,
        decayWeight: 0.1,
      }),
    );

    const result = decayRun(
      projectMemory,
      { olderThanDays: 60, accessCountLt: 3, weightGt: 0.3 },
      0.5,
    );

    expect(result.applied).toBe(1);
    expect(result.states.map((s) => s.name)).toEqual(["stale_a"]);
    expect(result.states[0]?.decayWeight).toBe(0.45);
  });

  // TC-2.9
  test("TC-2.9: decayIsTombstoned both for live tombstoned and dir lookup", () => {
    projectMemory.writeEntry(makeEntry({ name: "live_tomb" }));
    projectMemory.writeEntry(makeEntry({ name: "moved_tomb" }));

    expect(decayIsTombstoned(projectMemory, "live_tomb")).toBe(false);
    expect(decayIsTombstoned(projectMemory, "moved_tomb")).toBe(false);
    expect(decayIsTombstoned(projectMemory, "ghost")).toBe(false);

    decayTombstone(projectMemory, "moved_tomb");
    // After tombstone, file is in the tombstones dir → dir lookup hit.
    expect(decayIsTombstoned(projectMemory, "moved_tomb")).toBe(true);

    // Manually craft a "live tombstoned" state without moving the file
    // (simulates an edge-case where frontmatter says tombstoned but the file
    // still lives in memoryDir — decayIsTombstoned should still detect it).
    const path = join(projectMemory.memoryDir, "live_tomb.md");
    const original = readFileSync(path, "utf-8");
    const patched = original.replace("---\n", "---\ntombstoned: true\n");
    writeFileSync(path, patched, "utf-8");
    expect(decayIsTombstoned(projectMemory, "live_tomb")).toBe(true);
  });

  // TC-2.10
  test("TC-2.10: invalid decayRate (0, 1, -0.5, 2.0) → throws", () => {
    projectMemory.writeEntry(makeEntry({ name: "rate_check" }));

    expect(() => decayApply(projectMemory, "rate_check", { decayRate: 0 })).toThrow();
    expect(() => decayApply(projectMemory, "rate_check", { decayRate: 1 })).toThrow();
    expect(() => decayApply(projectMemory, "rate_check", { decayRate: -0.5 })).toThrow();
    expect(() => decayApply(projectMemory, "rate_check", { decayRate: 2.0 })).toThrow();
  });

  // TC-2.11
  test("TC-2.11: weight rounding precision (0.5 × 0.5 × 0.5 → exact 0.125)", () => {
    projectMemory.writeEntry(makeEntry({ name: "precise" }));
    const a = decayApply(projectMemory, "precise", { decayRate: 0.5 });
    expect(a.decayWeight).toBe(0.5);
    const b = decayApply(projectMemory, "precise", { decayRate: 0.5 });
    expect(b.decayWeight).toBe(0.25);
    const c = decayApply(projectMemory, "precise", { decayRate: 0.5 });
    expect(c.decayWeight).toBe(0.125);

    // Sanity for many rounds — must remain exactly representable to 6 decimals.
    for (let i = 0; i < 7; i += 1) {
      decayApply(projectMemory, "precise", { decayRate: 0.5 });
    }
    const final = projectMemory.readEntry("precise");
    // After 10 total halvings starting at 1.0 → 0.000977 (rounded to 6 decimals).
    expect(final?.decayWeight).toBe(0.000977);
  });

  // TC-2.E1
  test("TC-2.E1: decayApply on non-existent entry → throws", () => {
    expect(() => decayApply(projectMemory, "ghost")).toThrow(/not found/);
  });

  // TC-2.E2
  test("TC-2.E2: decayTombstone collision → suffix .1, .2, ...", () => {
    // Pre-seed tombstones dir with a file that would collide.
    const tombDir = getTombstonesDir(projectMemory.projectId, rootDir);
    mkdirSync(tombDir, { recursive: true });
    writeFileSync(join(tombDir, "duplicate.md"), "preexisting", "utf-8");

    projectMemory.writeEntry(makeEntry({ name: "duplicate" }));
    const first = decayTombstone(projectMemory, "duplicate");
    expect(first.filePath.endsWith("duplicate.1.md")).toBe(true);
    expect(existsSync(join(tombDir, "duplicate.md"))).toBe(true); // pre-existing
    expect(existsSync(join(tombDir, "duplicate.1.md"))).toBe(true);

    // Recreate live entry, tombstone again → should land at .2.
    projectMemory.writeEntry(makeEntry({ name: "duplicate" }));
    const second = decayTombstone(projectMemory, "duplicate");
    expect(second.filePath.endsWith("duplicate.2.md")).toBe(true);
    expect(existsSync(join(tombDir, "duplicate.2.md"))).toBe(true);
  });
});
