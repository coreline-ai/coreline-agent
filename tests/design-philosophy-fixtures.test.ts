/** Tests for design philosophy prompt experiment fixtures. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_PHILOSOPHY_FIXTURES,
  getFixtureById,
  getFixturesByCategory,
  listAllFixtures,
  registerDesignPhilosophyExperiment,
} from "../src/agent/self-improve/prompt-experiment-fixtures.js";
import {
  getExperiment,
  pickVariant,
} from "../src/agent/self-improve/prompt-experiment.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "design-phil-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("design-philosophy fixtures", () => {
  test("all fixtures have unique ids", () => {
    const ids = DESIGN_PHILOSOPHY_FIXTURES.map((f) => f.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBe(5);
  });

  test("each fixture's prompt has substantive detail (>=100 chars)", () => {
    for (const fixture of DESIGN_PHILOSOPHY_FIXTURES) {
      expect(fixture.prompt.length).toBeGreaterThanOrEqual(100);
    }
  });

  test("each fixture's bestFor list is non-empty", () => {
    for (const fixture of DESIGN_PHILOSOPHY_FIXTURES) {
      expect(Array.isArray(fixture.bestFor)).toBe(true);
      expect(fixture.bestFor.length).toBeGreaterThan(0);
    }
  });

  test("getFixtureById returns the correct fixture", () => {
    const fx = getFixtureById("pentagram-systematic");
    expect(fx).toBeDefined();
    expect(fx!.name).toContain("Pentagram");
    expect(getFixtureById("does-not-exist")).toBeUndefined();
  });

  test("getFixturesByCategory(\"minimalism\") returns 2 fixtures (kenya-hara + sagmeister)", () => {
    const minimal = getFixturesByCategory("minimalism");
    expect(minimal.length).toBe(2);
    const ids = minimal.map((f) => f.id).sort();
    expect(ids).toEqual([
      "kenya-hara-emptiness",
      "sagmeister-warm-minimal",
    ]);
  });

  test("listAllFixtures returns all 5 fixtures (defensive copy)", () => {
    const all = listAllFixtures();
    expect(all.length).toBe(5);
    // Mutating the returned array must not affect the internal source.
    all.pop();
    expect(DESIGN_PHILOSOPHY_FIXTURES.length).toBe(5);
  });

  test("registerDesignPhilosophyExperiment registers all 5 variants", () => {
    const name = registerDesignPhilosophyExperiment(tempRoot);
    expect(name).toBe("design-philosophy");

    const exp = getExperiment("design-philosophy", tempRoot);
    expect(exp).not.toBeNull();
    expect(exp!.variants.length).toBe(5);
    const variantIds = exp!.variants.map((v) => v.id).sort();
    const fixtureIds = DESIGN_PHILOSOPHY_FIXTURES.map((f) => f.id).sort();
    expect(variantIds).toEqual(fixtureIds);

    // pickVariant should return one of the registered fixtures.
    const picked = pickVariant({ name: "design-philosophy", rootDir: tempRoot });
    expect(picked).not.toBeNull();
    expect(fixtureIds).toContain(picked!.id);
  });

  test("license safety: no huashu-design distinctive text in fixtures", () => {
    // Distinctive phrases drawn from huashu-design's design-styles.md
    // (Korean/Chinese taglines unique to that document). None must appear
    // verbatim in our independently-written fixtures.
    const distinctivePhrases = [
      "공의 설계",
      "일식 사변",
      "极简",
      "极致克制",
      "禅风 minimalism",
      "情感设计",
      "信息架构派",
    ];
    for (const fixture of DESIGN_PHILOSOPHY_FIXTURES) {
      for (const phrase of distinctivePhrases) {
        expect(fixture.prompt).not.toContain(phrase);
        expect(fixture.name).not.toContain(phrase);
      }
    }
  });
});
