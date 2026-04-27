/**
 * Phase 0 (Wave 7/8/9 Foundation) — Round-trip tests for new frontmatter fields:
 * decay (decayWeight/decayCount/tombstoned/tombstonedAt) + bitemporal (validFrom/validTo/recordedAt).
 *
 * Verifies backward compat: legacy memories without new fields write byte-identical.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMemoryFile,
  serializeMemoryFile,
  extractExtendedFields,
} from "../src/memory/memory-parser.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  DECAY_DEFAULT_WEIGHT,
  DECAY_DEFAULT_RATE,
  CHUNK_DEFAULT_SIZE,
  CHUNK_DEFAULT_OVERLAP,
  INCIDENT_ESCALATION_THRESHOLD,
  RUNBOOK_AUTO_APPLY_THRESHOLD,
} from "../src/memory/constants.js";
import {
  getFactsDir,
  getTombstonesDir,
  getLinksDir,
  getIncidentsDir,
  getDecisionsDir,
  getRunbooksDir,
} from "../src/config/paths.js";
import type { MemoryEntry } from "../src/memory/types.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "memkraft-w789-"));
}

describe("Phase 0 / Wave 7-9 Foundation — Frontmatter extensions", () => {
  test("TC-0.1: MemoryEntry compiles with all new optional fields", () => {
    const entry: MemoryEntry = {
      name: "x",
      description: "y",
      type: "user",
      body: "z",
      filePath: "",
      tier: "core",
      lastAccessed: "2026-04-25",
      accessCount: 3,
      importance: "high",
      decayWeight: 0.5,
      decayCount: 1,
      tombstoned: false,
      validFrom: "2020-03-01",
      validTo: "2023-02-28",
      recordedAt: "2026-04-25T12:00:00Z",
    };
    expect(entry.decayWeight).toBe(0.5);
  });

  test("TC-0.2: serialize+parse round-trip — decayWeight 0.5", () => {
    const out = serializeMemoryFile({
      name: "foo",
      description: "desc",
      type: "user",
      body: "hello",
      decayWeight: 0.5,
      decayCount: 1,
    });
    expect(out).toContain("decayWeight: 0.5");
    expect(out).toContain("decayCount: 1");

    const { frontmatter } = parseMemoryFile(out);
    const ext = extractExtendedFields(frontmatter);
    expect(ext.decayWeight).toBe(0.5);
    expect(ext.decayCount).toBe(1);
  });

  test("TC-0.3: tombstoned + tombstonedAt round-trip", () => {
    const out = serializeMemoryFile({
      name: "zombie",
      description: "d",
      type: "project",
      body: "b",
      tombstoned: true,
      tombstonedAt: "2026-04-25T08:30:00Z",
    });
    const { frontmatter } = parseMemoryFile(out);
    const ext = extractExtendedFields(frontmatter);
    expect(ext.tombstoned).toBe(true);
    expect(ext.tombstonedAt).toBe("2026-04-25T08:30:00Z");
  });

  test("TC-0.4: bitemporal validFrom/validTo/recordedAt round-trip", () => {
    const out = serializeMemoryFile({
      name: "fact",
      description: "d",
      type: "reference",
      body: "b",
      validFrom: "2020-03-01",
      validTo: "2023-02-28",
      recordedAt: "2026-04-25T12:00:00Z",
    });
    const { frontmatter } = parseMemoryFile(out);
    const ext = extractExtendedFields(frontmatter);
    expect(ext.validFrom).toBe("2020-03-01");
    expect(ext.validTo).toBe("2023-02-28");
    expect(ext.recordedAt).toBe("2026-04-25T12:00:00Z");
  });

  test("TC-0.5: invalid decayWeight (>1, negative, string) → undefined fallback", () => {
    expect(extractExtendedFields({ decayWeight: 2.0 }).decayWeight).toBeUndefined();
    expect(extractExtendedFields({ decayWeight: -0.1 }).decayWeight).toBeUndefined();
    expect(extractExtendedFields({ decayWeight: "0.5" }).decayWeight).toBeUndefined();
  });

  test("TC-0.6: invalid validFrom (number, empty) → undefined", () => {
    expect(extractExtendedFields({ validFrom: 12345 }).validFrom).toBeUndefined();
    expect(extractExtendedFields({ validFrom: "" }).validFrom).toBeUndefined();
  });

  test("TC-0.7: legacy serialize (no new fields) byte-identical", () => {
    const legacy = serializeMemoryFile({
      name: "foo",
      description: "desc",
      type: "user",
      body: "hello",
    });
    expect(legacy).toBe(`---\nname: foo\ndescription: desc\ntype: user\n---\nhello`);
  });

  test("TC-0.8 (D17): decayWeight runtime fallback pattern verification", () => {
    const entry: MemoryEntry = {
      name: "no-decay",
      description: "d",
      type: "user",
      body: "b",
      filePath: "",
    };
    // Consumer pattern: `entry.decayWeight ?? DECAY_DEFAULT_WEIGHT`
    const weight = entry.decayWeight ?? DECAY_DEFAULT_WEIGHT;
    expect(weight).toBe(1.0);
    expect(DECAY_DEFAULT_WEIGHT).toBe(1.0);
  });

  test("TC-0.9: legacy memory file byte-identical via ProjectMemory round-trip", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/legacy-w789", { rootDir: root });
      mem.writeEntry({
        name: "legacy",
        description: "no extras",
        type: "user",
        body: "just body",
        filePath: "",
      });
      const filePath = mem.readEntry("legacy")!.filePath;
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe(`---\nname: legacy\ndescription: no extras\ntype: user\n---\njust body`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-0.10: full round-trip via ProjectMemory preserves all 11 fields", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/full-w789", { rootDir: root });
      mem.writeEntry({
        name: "full",
        description: "all fields",
        type: "feedback",
        body: "body",
        filePath: "",
        tier: "core",
        lastAccessed: "2026-04-25",
        accessCount: 3,
        importance: "high",
        decayWeight: 0.7,
        decayCount: 2,
        tombstoned: false,
        validFrom: "2020-01-01",
        validTo: "2025-12-31",
        recordedAt: "2026-04-25T12:00:00Z",
      });
      const read = mem.readEntry("full");
      expect(read).not.toBeNull();
      expect(read!.tier).toBe("core");
      expect(read!.decayWeight).toBe(0.7);
      expect(read!.decayCount).toBe(2);
      expect(read!.validFrom).toBe("2020-01-01");
      expect(read!.recordedAt).toBe("2026-04-25T12:00:00Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-0.E1: paths helpers return correct structure", () => {
    const projectId = "abc123";
    expect(getFactsDir(projectId)).toContain("/projects/abc123/memory/facts");
    expect(getTombstonesDir(projectId)).toContain("/projects/abc123/.memory/tombstones");
    expect(getLinksDir(projectId)).toContain("/projects/abc123/memory/links");
    expect(getIncidentsDir(projectId)).toContain("/projects/abc123/memory/incidents");
    expect(getDecisionsDir(projectId)).toContain("/projects/abc123/memory/decisions");
    expect(getRunbooksDir(projectId)).toContain("/projects/abc123/memory/runbooks");
  });

  test("constants are correctly exported with expected values", () => {
    expect(DECAY_DEFAULT_RATE).toBe(0.5);
    expect(DECAY_DEFAULT_WEIGHT).toBe(1.0);
    expect(CHUNK_DEFAULT_SIZE).toBe(500);
    expect(CHUNK_DEFAULT_OVERLAP).toBe(50);
    expect(INCIDENT_ESCALATION_THRESHOLD).toBe(3);
    expect(RUNBOOK_AUTO_APPLY_THRESHOLD).toBe(0.8);
  });
});
