/**
 * Phase 1 (Wave 7) — Bitemporal Fact Layer tests.
 *
 * Covers factAdd / factAt / factHistory / factInvalidate / factList / factKeys
 * against MemKraft bitemporal.py semantics, with TS-specific best-effort I/O.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  factAdd,
  factAt,
  factHistory,
  factInvalidate,
  factKeys,
  factList,
} from "../src/memory/facts.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "facts-test-"));
}

describe("Phase 1 / Wave 7 — Bitemporal Fact Layer", () => {
  test("TC-1.1: factAdd round-trip — file created with exact markdown", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-1", { rootDir: root });
      const result = factAdd(mem, "Simon", "role", "CEO of Hashed", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });
      expect(result.written).toBe(true);
      expect(result.filePath).toBeDefined();
      expect(existsSync(result.filePath!)).toBe(true);

      const content = readFileSync(result.filePath!, "utf-8");
      expect(content).toContain("# Entity: Simon");
      expect(content).toContain(
        "- role: CEO of Hashed <!-- valid:[2020-03-01..) recorded:2026-04-17T00:30 -->",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.2: factAt with asOf within validity → returns fact", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-2", { rootDir: root });
      factAdd(mem, "Simon", "role", "CTO", {
        validFrom: "2018-01-01",
        validTo: "2020-02-29",
        recordedAt: "2024-05-10T14:22",
      });
      const fact = factAt(mem, "Simon", "role", { asOf: "2019-06-01" });
      expect(fact).not.toBeNull();
      expect(fact!.value).toBe("CTO");
      expect(fact!.validFrom).toBe("2018-01-01");
      expect(fact!.validTo).toBe("2020-02-29");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.3: factAt with asOf outside validity → returns null", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-3", { rootDir: root });
      factAdd(mem, "Simon", "role", "CTO", {
        validFrom: "2018-01-01",
        validTo: "2020-02-29",
        recordedAt: "2024-05-10T14:22",
      });
      const fact = factAt(mem, "Simon", "role", { asOf: "2025-01-01" });
      expect(fact).toBeNull();

      const before = factAt(mem, "Simon", "role", { asOf: "2017-01-01" });
      expect(before).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.4: overlapping range, different recordedAt → factAt returns most recent recordedAt", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-4", { rootDir: root });
      // Older belief
      factAdd(mem, "Simon", "role", "CTO", {
        validFrom: "2020-01-01",
        validTo: "2025-12-31",
        recordedAt: "2024-05-10T14:22",
      });
      // Newer belief about same period
      factAdd(mem, "Simon", "role", "CEO", {
        validFrom: "2020-01-01",
        validTo: "2025-12-31",
        recordedAt: "2026-04-17T00:30",
      });
      const fact = factAt(mem, "Simon", "role", { asOf: "2022-06-01" });
      expect(fact).not.toBeNull();
      expect(fact!.value).toBe("CEO");
      expect(fact!.recordedAt).toBe("2026-04-17T00:30");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.5: factHistory sorted by recordedAt desc", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-5", { rootDir: root });
      factAdd(mem, "Simon", "role", "CTO", { recordedAt: "2024-05-10T14:22" });
      factAdd(mem, "Simon", "role", "CEO", { recordedAt: "2026-04-17T00:30" });
      factAdd(mem, "Simon", "role", "Founder", { recordedAt: "2025-01-01T09:00" });

      const history = factHistory(mem, "Simon");
      expect(history).toHaveLength(3);
      expect(history[0]!.recordedAt).toBe("2026-04-17T00:30");
      expect(history[1]!.recordedAt).toBe("2025-01-01T09:00");
      expect(history[2]!.recordedAt).toBe("2024-05-10T14:22");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.6: factHistory(entity, key) filter", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-6", { rootDir: root });
      factAdd(mem, "Simon", "role", "CEO", { recordedAt: "2026-01-01T00:00" });
      factAdd(mem, "Simon", "company", "Hashed", { recordedAt: "2026-01-02T00:00" });
      factAdd(mem, "Simon", "role", "CTO", { recordedAt: "2024-01-01T00:00" });

      const onlyRoles = factHistory(mem, "Simon", "role");
      expect(onlyRoles).toHaveLength(2);
      expect(onlyRoles.every((f) => f.key === "role")).toBe(true);

      const onlyCompany = factHistory(mem, "Simon", "company");
      expect(onlyCompany).toHaveLength(1);
      expect(onlyCompany[0]!.value).toBe("Hashed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.7: factInvalidate closes open interval, count matches", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-7", { rootDir: root });
      factAdd(mem, "Simon", "role", "CEO", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });
      factAdd(mem, "Simon", "role", "Advisor", {
        validFrom: "2021-01-01",
        recordedAt: "2026-04-17T00:31",
      });
      // Already-closed fact should NOT be modified.
      factAdd(mem, "Simon", "role", "Intern", {
        validFrom: "2017-01-01",
        validTo: "2017-12-31",
        recordedAt: "2018-01-01T00:00",
      });

      const count = factInvalidate(mem, "Simon", "role", {
        invalidAt: "2026-04-26",
        recordedAt: "2026-04-26T10:00",
      });
      expect(count).toBe(2);

      // Verify open intervals are now closed in the file
      const all = factHistory(mem, "Simon", "role");
      const openCount = all.filter((f) => f.validTo === undefined).length;
      expect(openCount).toBe(0);

      // Original Intern fact still has its original validTo
      const intern = all.find((f) => f.value === "Intern");
      expect(intern).toBeDefined();
      expect(intern!.validTo).toBe("2017-12-31");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.8: factList returns all facts", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-8", { rootDir: root });
      factAdd(mem, "Simon", "role", "CEO", { recordedAt: "2026-01-01T00:00" });
      factAdd(mem, "Simon", "company", "Hashed", { recordedAt: "2026-01-02T00:00" });
      factAdd(mem, "Simon", "city", "Seoul", { recordedAt: "2026-01-03T00:00" });

      const list = factList(mem, "Simon");
      expect(list).toHaveLength(3);
      const keys = list.map((f) => f.key).sort();
      expect(keys).toEqual(["city", "company", "role"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.9: factKeys deduplicates + sorts", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-9", { rootDir: root });
      factAdd(mem, "Simon", "role", "CEO", { recordedAt: "2026-01-01T00:00" });
      factAdd(mem, "Simon", "role", "CTO", { recordedAt: "2024-01-01T00:00" });
      factAdd(mem, "Simon", "company", "Hashed", { recordedAt: "2026-01-02T00:00" });
      factAdd(mem, "Simon", "city", "Seoul", { recordedAt: "2026-01-03T00:00" });

      const keys = factKeys(mem, "Simon");
      expect(keys).toEqual(["city", "company", "role"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.10: validFrom > validTo input → returns error result", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-10", { rootDir: root });
      const result = factAdd(mem, "Simon", "role", "CEO", {
        validFrom: "2025-01-01",
        validTo: "2020-01-01",
        recordedAt: "2026-04-17T00:30",
      });
      expect(result.written).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toContain("valid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.11: ISO + YYYY-MM-DD date formats both accepted", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-11", { rootDir: root });
      const r1 = factAdd(mem, "Simon", "role", "CEO", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });
      const r2 = factAdd(mem, "Alice", "role", "Engineer", {
        validFrom: "2022-06-15T09:00:00Z",
        recordedAt: "2026-04-17T00:30:45",
      });
      expect(r1.written).toBe(true);
      expect(r2.written).toBe(true);

      const fact1 = factAt(mem, "Simon", "role", { asOf: "2024-01-01" });
      expect(fact1).not.toBeNull();
      expect(fact1!.validFrom).toBe("2020-03-01");

      const fact2 = factAt(mem, "Alice", "role", { asOf: "2024-01-01" });
      expect(fact2).not.toBeNull();
      expect(fact2!.validFrom).toBe("2022-06-15T09:00:00Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.E1: persistence — write then read in fresh ProjectMemory instance", () => {
    const root = mkTmp();
    try {
      const cwd = "/tmp/test-facts-persist";
      const mem1 = new ProjectMemory(cwd, { rootDir: root });
      factAdd(mem1, "Simon", "role", "CEO of Hashed", {
        validFrom: "2020-03-01",
        recordedAt: "2026-04-17T00:30",
      });
      factAdd(mem1, "Simon", "role", "CTO", {
        validFrom: "2018-01-01",
        validTo: "2020-02-29",
        recordedAt: "2024-05-10T14:22",
      });

      // Fresh instance reads from disk
      const mem2 = new ProjectMemory(cwd, { rootDir: root });
      const history = factHistory(mem2, "Simon", "role");
      expect(history).toHaveLength(2);
      const values = history.map((f) => f.value).sort();
      expect(values).toEqual(["CEO of Hashed", "CTO"]);

      const current = factAt(mem2, "Simon", "role", { asOf: "2026-01-01" });
      expect(current).not.toBeNull();
      expect(current!.value).toBe("CEO of Hashed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TC-1.E2: multi-entity isolation — Simon's facts ≠ Alice's facts", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/test-facts-iso", { rootDir: root });
      factAdd(mem, "Simon", "role", "CEO", { recordedAt: "2026-01-01T00:00" });
      factAdd(mem, "Alice", "role", "Engineer", { recordedAt: "2026-01-01T00:00" });
      factAdd(mem, "Simon", "company", "Hashed", { recordedAt: "2026-01-02T00:00" });

      const simonKeys = factKeys(mem, "Simon");
      expect(simonKeys).toEqual(["company", "role"]);

      const aliceKeys = factKeys(mem, "Alice");
      expect(aliceKeys).toEqual(["role"]);

      const aliceList = factList(mem, "Alice");
      expect(aliceList).toHaveLength(1);
      expect(aliceList[0]!.value).toBe("Engineer");

      // No cross-contamination
      expect(factAt(mem, "Alice", "company")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
