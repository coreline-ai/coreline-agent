/**
 * Phase 0 (D14) — Ratcliff-Obershelp similarity TS port verification.
 *
 * Reference values computed via Python `difflib.SequenceMatcher(None, a, b).ratio()`
 * to ±0.01 (rounding/edge differences are expected per Python's quick_ratio fast paths).
 */

import { describe, expect, test } from "bun:test";
import { similarityScore, similarityScoreFuzzy } from "../src/memory/similarity.js";

interface KnownPair {
  a: string;
  b: string;
  expected: number; // MemKraft Python reference
  tolerance?: number;
}

// Python reference: difflib.SequenceMatcher(None, a, b).ratio()
// Computed manually for representative pairs covering Wave 8/9 use cases.
const KNOWN_PAIRS: KnownPair[] = [
  // Identity / empty edge cases
  { a: "", b: "", expected: 1.0 },
  { a: "abc", b: "abc", expected: 1.0 },
  { a: "abc", b: "", expected: 0.0 },
  { a: "", b: "xyz", expected: 0.0 },

  // Tiny strings
  { a: "a", b: "a", expected: 1.0 },
  { a: "a", b: "b", expected: 0.0 },
  { a: "ab", b: "ba", expected: 0.5 }, // 2*1/(2+2) = 0.5

  // Realistic incident/runbook symptoms — values verified against Ratcliff-Obershelp implementation
  { a: "connection pool exhausted", b: "connection pool full", expected: 0.7556, tolerance: 0.01 },
  { a: "API timeout", b: "API request timeout", expected: 0.7333, tolerance: 0.01 },
  { a: "database query slow", b: "slow database query", expected: 0.7368, tolerance: 0.01 },

  // Korean (UTF-16 char-level)
  { a: "연결 풀 고갈", b: "연결 풀 고갈", expected: 1.0 },
  { a: "데이터베이스 연결 실패", b: "데이터베이스 쿼리 실패", expected: 0.8333, tolerance: 0.01 },

  // Typical RCA hypothesis matching
  { a: "rate limit exceeded", b: "API rate limited", expected: 0.6857, tolerance: 0.01 },

  // Substring containment
  { a: "ETIMEDOUT", b: "connection ETIMEDOUT error", expected: 0.5143, tolerance: 0.01 },

  // Completely unrelated
  { a: "alpha beta gamma", b: "xxxxxxxxxxxxxxxx", expected: 0.0, tolerance: 0.05 },

  // Order-preserving partial match
  { a: "abcdef", b: "abcXef", expected: 0.833, tolerance: 0.01 },

  // Repeated chars
  { a: "aaaa", b: "aa", expected: 0.667, tolerance: 0.01 },
  { a: "abab", b: "baba", expected: 0.75, tolerance: 0.01 },

  // Reversed (low ratio expected) — gestalt finds "a", "b", "c" individually
  { a: "abcdef", b: "fedcba", expected: 0.1667, tolerance: 0.05 },

  // Long, mostly matching (one diff)
  { a: "the quick brown fox", b: "the quick brown dog", expected: 0.8947, tolerance: 0.01 },
];

describe("similarityScore — Ratcliff-Obershelp port (D14)", () => {
  for (const { a, b, expected, tolerance = 0.01 } of KNOWN_PAIRS) {
    test(`sim(${JSON.stringify(a).slice(0, 30)}, ${JSON.stringify(b).slice(0, 30)}) ≈ ${expected}`, () => {
      const got = similarityScore(a, b);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(1);
      expect(Math.abs(got - expected)).toBeLessThanOrEqual(tolerance);
    });
  }
});

describe("similarityScoreFuzzy — case + whitespace insensitive", () => {
  test("Casing differences ignored", () => {
    expect(similarityScoreFuzzy("HELLO World", "hello world")).toBe(1.0);
  });

  test("Whitespace normalized", () => {
    expect(similarityScoreFuzzy("foo  bar", "foo bar")).toBe(1.0);
    expect(similarityScoreFuzzy("  foo bar  ", "foo bar")).toBe(1.0);
  });

  test("Partial match still scored", () => {
    const score = similarityScoreFuzzy("Connection Timeout", "connection timeout error");
    expect(score).toBeGreaterThan(0.7);
  });
});

describe("similarityScore — algorithmic invariants", () => {
  test("commutative: sim(a, b) === sim(b, a)", () => {
    const pairs: [string, string][] = [
      ["foo bar baz", "foo qux baz"],
      ["abc", "xyz"],
      ["hello", "hxllo"],
    ];
    for (const [a, b] of pairs) {
      expect(similarityScore(a, b)).toBeCloseTo(similarityScore(b, a), 5);
    }
  });

  test("score in [0, 1]", () => {
    const samples = [
      ["", ""],
      ["a", "abc"],
      ["short", "much longer string here"],
      ["xyz", "abc"],
    ] as [string, string][];
    for (const [a, b] of samples) {
      const s = similarityScore(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("identity: sim(s, s) === 1.0", () => {
    for (const s of ["", "a", "hello world", "데이터베이스 연결 실패"]) {
      expect(similarityScore(s, s)).toBe(1.0);
    }
  });
});
