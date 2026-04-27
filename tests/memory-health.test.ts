/**
 * Wave 10 P3 O3 — /memory health diagnostic.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import { computeMemoryHealth, formatMemoryHealthMarkdown } from "../src/memory/health.js";
import { tierSet } from "../src/memory/tiering.js";
import { decayApply } from "../src/memory/decay.js";
import { incidentRecord, incidentUpdate } from "../src/agent/incident/incident-store.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "memory-health-"));
}

describe("computeMemoryHealth (O3)", () => {
  test("empty project → healthy, all counts 0", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/health-empty", { rootDir: root });
      const report = computeMemoryHealth(mem, root);
      expect(report.totalEntries).toBe(0);
      expect(report.totalChars).toBe(0);
      expect(report.tierDistribution).toEqual({ core: 0, recall: 0, archival: 0 });
      expect(report.records.incidents.open).toBe(0);
      expect(report.status).toBe("healthy");
      expect(report.recommendations).toContain("Memory is healthy ✅");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mixed tier distribution accurate", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/health-mixed", { rootDir: root });
      // 2 core + 3 recall + 1 archival
      for (let i = 0; i < 2; i++) {
        mem.writeEntry({ name: `core-${i}`, description: "c", type: "user", body: "x", filePath: "", tier: "core" });
      }
      for (let i = 0; i < 3; i++) {
        mem.writeEntry({ name: `recall-${i}`, description: "r", type: "reference", body: "y", filePath: "", tier: "recall" });
      }
      mem.writeEntry({ name: "arch-0", description: "a", type: "reference", body: "z", filePath: "", tier: "archival" });

      const report = computeMemoryHealth(mem, root);
      expect(report.totalEntries).toBe(6);
      expect(report.tierDistribution.core).toBe(2);
      expect(report.tierDistribution.recall).toBe(3);
      expect(report.tierDistribution.archival).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("incidents counted by status", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/health-inc", { rootDir: root });
      const projectId = mem.projectId;

      const id1 = incidentRecord(projectId, "Open inc", ["sym"], { severity: "low" }, root);
      const id2 = incidentRecord(projectId, "Resolved inc", ["sym"], { severity: "low" }, root);
      incidentUpdate(projectId, id2, { resolution: "fixed" }, root);

      const report = computeMemoryHealth(mem, root);
      expect(report.records.incidents.open).toBe(1);
      expect(report.records.incidents.resolved).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("decay weight buckets distribute correctly", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/health-decay", { rootDir: root });
      // Create entries with varied decay weights
      mem.writeEntry({ name: "high1", description: "h", type: "user", body: "x", filePath: "", tier: "recall", decayWeight: 0.9 });
      mem.writeEntry({ name: "med1", description: "m", type: "user", body: "x", filePath: "", tier: "recall", decayWeight: 0.6 });
      mem.writeEntry({ name: "low1", description: "l", type: "user", body: "x", filePath: "", tier: "recall", decayWeight: 0.3 });
      mem.writeEntry({ name: "verylow1", description: "v", type: "user", body: "x", filePath: "", tier: "recall", decayWeight: 0.1 });
      mem.writeEntry({ name: "default1", description: "d", type: "user", body: "x", filePath: "", tier: "recall" }); // undefined → 1.0

      const report = computeMemoryHealth(mem, root);
      // high (≥0.75): 0.9 + default 1.0 = 2
      // medium (0.5-0.75): 0.6 = 1
      // low (0.25-0.5): 0.3 = 1
      // very low (<0.25): 0.1 = 1
      expect(report.decay.weightDistribution.high).toBe(2);
      expect(report.decay.weightDistribution.medium).toBe(1);
      expect(report.decay.weightDistribution.low).toBe(1);
      expect(report.decay.weightDistribution.veryLow).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("formatMemoryHealthMarkdown produces structured output", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/health-fmt", { rootDir: root });
      const report = computeMemoryHealth(mem, root);
      const md = formatMemoryHealthMarkdown(report);
      expect(md).toContain("# Memory Health");
      expect(md).toContain("## Tier Distribution");
      expect(md).toContain("## Decay Weight Distribution");
      expect(md).toContain("## Records");
      expect(md).toContain("## Recommendations");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
