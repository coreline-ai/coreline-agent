/**
 * Wave 10 P3 O1 — Evidence JSONL rolling retention tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rotateEvidence,
  rotateAllEvidence,
  previewRotation,
} from "../src/agent/self-improve/evidence-rotation.js";
import { appendEvidence } from "../src/agent/self-improve/evidence.js";
import type { EvidenceRecord } from "../src/agent/self-improve/types.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "evidence-rotation-"));
}

function mkRecord(
  id: string,
  daysAgo: number,
  iter = 1,
): EvidenceRecord {
  return {
    domain: "skill",
    id,
    sessionId: `s-${iter}`,
    iteration: iter,
    invokedAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
    outcome: { success: true, turnsUsed: 3 },
  };
}

describe("rotateEvidence (O1)", () => {
  test("91-day-old record → moved to archive", () => {
    const root = mkTmp();
    try {
      const projectId = "rot-test-1";
      appendEvidence(projectId, mkRecord("dev-plan", 91, 1), root);
      appendEvidence(projectId, mkRecord("dev-plan", 89, 2), root);

      const result = rotateEvidence(projectId, "skill", { maxAgeDays: 90 }, root);
      expect(result.recordsArchived).toBeGreaterThanOrEqual(1);
      expect(result.bytesFreed).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("89-day-old record → preserved (under threshold)", () => {
    const root = mkTmp();
    try {
      const projectId = "rot-test-2";
      appendEvidence(projectId, mkRecord("dev-plan", 89, 1), root);

      const result = rotateEvidence(projectId, "skill", { maxAgeDays: 90 }, root);
      expect(result.recordsArchived).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run via previewRotation does not move files", () => {
    const root = mkTmp();
    try {
      const projectId = "rot-test-3";
      appendEvidence(projectId, mkRecord("dev-plan", 91, 1), root);

      const preview = previewRotation(projectId, "skill", { maxAgeDays: 90 }, root);
      expect(preview.recordsArchived).toBeGreaterThanOrEqual(0);

      // Verify nothing was actually moved
      const archiveExists = existsSync(join(root, "projects", "rot-test-3", ".archive"));
      // archive may or may not exist as empty dir — but no archive file
      if (archiveExists) {
        const contents = readdirSync(join(root, "projects", "rot-test-3", ".archive"));
        // Should be empty or have empty subdirs
        expect(contents.length === 0 || contents.every((f) => readdirSync(join(root, "projects", "rot-test-3", ".archive", f)).length === 0)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty domain → noop", () => {
    const root = mkTmp();
    try {
      const result = rotateEvidence("rot-test-empty", "skill", undefined, root);
      expect(result.recordsArchived).toBe(0);
      expect(result.filesRotated).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotateAllEvidence iterates all 3 domains", () => {
    const root = mkTmp();
    try {
      const projectId = "rot-test-all";
      appendEvidence(projectId, { ...mkRecord("dev-plan", 91, 1), domain: "skill" }, root);
      appendEvidence(projectId, { ...mkRecord("Explore", 91, 1), domain: "subagent" }, root);
      appendEvidence(projectId, { ...mkRecord("test-prompt", 91, 1), domain: "prompt" }, root);

      const results = rotateAllEvidence(projectId, { maxAgeDays: 90 }, root);
      expect(results.length).toBeGreaterThanOrEqual(3);
      const domains = new Set(results.map((r) => r.domain));
      expect(domains.has("skill")).toBe(true);
      expect(domains.has("subagent")).toBe(true);
      expect(domains.has("prompt")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("custom maxAgeDays policy applied", () => {
    const root = mkTmp();
    try {
      const projectId = "rot-test-custom";
      appendEvidence(projectId, mkRecord("x", 31, 1), root);
      appendEvidence(projectId, mkRecord("x", 29, 2), root);

      const result = rotateEvidence(projectId, "skill", { maxAgeDays: 30 }, root);
      expect(result.recordsArchived).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
