/**
 * huashu-design integration smoke tests — verifies brand-spec + critique + slop interplay.
 * Concepts inspired by huashu-design (Personal Use License).
 * https://github.com/alchaincyf/huashu-design
 *
 * E2E scenarios crossing brand-spec, critique heuristic fallback, slop detection,
 * and design-philosophy fixtures (Phase 0-5 integration).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ProjectMemory } from "../src/memory/project-memory.js";
import {
  createBrandSpecTemplate,
  buildBrandSpecEntry,
  validateBrandSpec,
  brandSpecEntryName,
} from "../src/memory/brand-spec.js";
import { tierList } from "../src/memory/tiering.js";
import { computeCritique } from "../src/agent/critique/engine.js";
import { detectAISlopSignals, formatSlopReport } from "../src/agent/reliability/slop-detector.js";
import {
  DESIGN_PHILOSOPHY_FIXTURES,
  listAllFixtures,
} from "../src/agent/self-improve/prompt-experiment-fixtures.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "huashu-smoke-"));
}

describe("S1: brand-spec → tier auto-core injection", () => {
  test("brand-spec entry lands in core tier and survives tierList sort", () => {
    const root = mkTmp();
    try {
      const mem = new ProjectMemory("/tmp/huashu-s1", { rootDir: root });
      const entry = buildBrandSpecEntry("acme");
      mem.writeEntry({ ...entry, filePath: "" });

      const stored = mem.readEntry(brandSpecEntryName("acme"));
      expect(stored).not.toBeNull();
      expect(stored?.type).toBe("brand-spec");
      expect(stored?.tier).toBe("core");

      // Listed in core group
      const list = tierList(mem);
      const found = list.find((e) => e.name === brandSpecEntryName("acme"));
      expect(found?.tier).toBe("core");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("brand-spec template contains required sections", () => {
    const tpl = createBrandSpecTemplate("acme");
    expect(tpl).toContain("# Brand Spec");
    expect(tpl).toContain("Core Identity");
    expect(tpl).toContain("Typography");
    expect(tpl).toContain("Tone");
  });
});

describe("S2: critique heuristic fallback (no LLM env)", () => {
  test("computeCritique returns 5 dimensions in heuristic mode", async () => {
    const prev = process.env.CRITIQUE_LLM_ENABLED;
    process.env.CRITIQUE_LLM_ENABLED = "false";
    try {
      const result = await computeCritique({
        targetPath: "fake.html",
        content: `<html><head><style>.card{}</style></head><body><h1>Title</h1><h2>Sub</h2><p>Text</p></body></html>`,
      });
      expect(result.scores.length).toBe(5);
      expect(result.strategy).toBe("heuristic");
      expect(result.overallScore).toBeGreaterThan(0);
      expect(result.overallScore).toBeLessThanOrEqual(10);
      const dims = result.scores.map((s) => s.dimension).sort();
      expect(dims).toEqual([
        "craft",
        "functionality",
        "originality",
        "philosophy",
        "visual-hierarchy",
      ]);
    } finally {
      if (prev === undefined) delete process.env.CRITIQUE_LLM_ENABLED;
      else process.env.CRITIQUE_LLM_ENABLED = prev;
    }
  });
});

describe("S3: slop detector flags known patterns", () => {
  test("HTML with 3+ slop signals reports correctly", () => {
    const html = `<style>
      .hero { background: linear-gradient(135deg, #9333ea, #ec4899); font-family: 'Inter'; }
      .card { border-radius: 12px; border-left: 4px solid #3b82f6; }
    </style>
    <h1>Features 🚀</h1>
    <p>We seamlessly leverage robust solutions.</p>`;

    const signals = detectAISlopSignals(html);
    expect(signals.length).toBeGreaterThanOrEqual(3);

    const ids = signals.map((s) => s.patternId);
    expect(ids).toContain("purple-gradient");
    expect(ids).toContain("decorative-emoji");

    const report = formatSlopReport(signals);
    expect(report).toContain("warning");
  });

  test("clean HTML produces no slop signals", () => {
    const html = `<style>
      body { color: #111; background: #f5f4f0; font-family: 'Source Serif 4', serif; }
      h1 { font-family: 'Source Serif 4', serif; }
      p { font-family: Inter, sans-serif; }
    </style>
    <h1>Welcome</h1>
    <p>This document explains our approach with concrete examples.</p>`;
    const signals = detectAISlopSignals(html);
    expect(signals.length).toBe(0);
  });
});

describe("S4: design philosophy fixtures available", () => {
  test("5 fixtures exposed", () => {
    const fixtures = listAllFixtures();
    expect(fixtures.length).toBe(5);
    const ids = fixtures.map((f) => f.id).sort();
    expect(ids).toEqual([
      "field-io-generative",
      "kenya-hara-emptiness",
      "pentagram-systematic",
      "sagmeister-warm-minimal",
      "takram-diagrammatic",
    ]);
  });

  test("each fixture has substantive prompt", () => {
    for (const fixture of DESIGN_PHILOSOPHY_FIXTURES) {
      expect(fixture.prompt.length).toBeGreaterThan(100);
      expect(fixture.bestFor.length).toBeGreaterThan(0);
    }
  });
});

describe("S5: license safety — no huashu text leaked into our modules", () => {
  test("brand-spec template does not contain huashu distinctive phrases", () => {
    const tpl = createBrandSpecTemplate("test");
    const distinctivePhrases = ["公의 设计", "공의 설계", "极简", "极致克制", "禅风"];
    for (const phrase of distinctivePhrases) {
      expect(tpl).not.toContain(phrase);
    }
  });

  test("design fixture prompts do not contain huashu distinctive phrases", () => {
    const distinctivePhrases = ["공의 설계", "일식 사변", "极简", "极致克制", "禅风 minimalism"];
    for (const fixture of DESIGN_PHILOSOPHY_FIXTURES) {
      for (const phrase of distinctivePhrases) {
        expect(fixture.prompt).not.toContain(phrase);
        expect(fixture.name).not.toContain(phrase);
      }
    }
  });

  test("all huashu-related modules carry attribution header", () => {
    const filesToCheck = [
      "src/memory/brand-spec.ts",
      "src/memory/brand-spec-types.ts",
      "src/agent/critique/engine.ts",
      "src/agent/critique/types.ts",
      "src/agent/critique/heuristic-fallback.ts",
      "src/agent/critique/prompt-builder.ts",
      "src/agent/reliability/slop-detector.ts",
      "src/agent/reliability/slop-patterns.ts",
      "src/agent/self-improve/prompt-experiment-fixtures.ts",
    ];
    // Repository root via existing layout
    const repoRoot = join(import.meta.dir, "..");
    for (const rel of filesToCheck) {
      const path = join(repoRoot, rel);
      if (!existsSync(path)) continue; // Some files may not exist if Phase x deferred
      const content = readFileSync(path, "utf-8");
      // Must mention huashu-design somewhere in the first 600 chars (attribution header)
      const head = content.slice(0, 600);
      expect(head.toLowerCase()).toContain("huashu-design");
    }
  });
});

describe("S6: validateBrandSpec sanity (legacy test cross-reference)", () => {
  test("template passes validation", () => {
    const tpl = createBrandSpecTemplate("acme");
    const result = validateBrandSpec(tpl);
    expect(result.valid).toBe(true);
  });

  test("empty body fails validation", () => {
    const result = validateBrandSpec("");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
