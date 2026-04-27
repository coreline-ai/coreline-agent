/**
 * Runbook pattern matcher (Wave 9 Phase 8).
 *
 * Computes similarity between a runbook pattern and a candidate symptom.
 * Patterns containing regex metacharacters are tried as regex first; on a
 * regex hit similarity is forced to 1.0. Otherwise (and on regex compile
 * error / no match) we fall back to Ratcliff-Obershelp fuzzy similarity
 * via `src/memory/similarity.ts` (D14).
 */

import { similarityScoreFuzzy } from "../../memory/similarity.js";

const REGEX_METACHARS = /[.*+?\[\]|()\\]/;

/** Heuristic: does this pattern look like a regex? */
export function isLikelyRegex(pattern: string): boolean {
  return REGEX_METACHARS.test(pattern);
}

/** Compute similarity (or 1.0 if regex matches symptom). Falls back to similarity on regex compile error. */
export function patternSimilarity(
  pattern: string,
  symptom: string,
): { sim: number; isRegex: boolean } {
  if (isLikelyRegex(pattern)) {
    try {
      const re = new RegExp(pattern, "i");
      if (re.test(symptom)) return { sim: 1.0, isRegex: true };
      return { sim: similarityScoreFuzzy(pattern, symptom), isRegex: false };
    } catch {
      // Invalid regex → fall back to fuzzy similarity
      return { sim: similarityScoreFuzzy(pattern, symptom), isRegex: false };
    }
  }
  return { sim: similarityScoreFuzzy(pattern, symptom), isRegex: false };
}

/** MemKraft scoring: 0.6 * similarity + 0.4 * confidence. */
export function scoreMatch(similarity: number, confidence: number): number {
  return 0.6 * similarity + 0.4 * confidence;
}
