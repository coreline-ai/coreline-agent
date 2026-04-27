/**
 * String similarity utility — Ratcliff-Obershelp algorithm port (D14).
 *
 * MemKraft uses Python's `difflib.SequenceMatcher.ratio()` which implements
 * Ratcliff-Obershelp (gestalt pattern matching). To preserve MemKraft parity
 * for Wave 8/9 (Runbook pattern match, RCA hypothesis scoring,
 * related-incidents similarity), we port the algorithm here.
 *
 * References:
 * - https://docs.python.org/3/library/difflib.html#difflib.SequenceMatcher
 * - Original paper: Ratcliff & Metzener, "Pattern matching: the gestalt approach" (1988)
 *
 * Result: `similarityScore(a, b) ∈ [0, 1]`, ±0.01 of MemKraft on the 20-pair
 * fixture in `tests/memory-similarity.test.ts`.
 *
 * Performance: O(n*m) worst case where n,m = lengths. For our use cases
 * (symptom strings, runbook patterns), strings are typically <200 chars
 * so this is practically fast (~ms).
 */

interface MatchingBlock {
  a: number;
  b: number;
  size: number;
}

/** Find the longest contiguous matching subsequence in a[al:ah] and b[bl:bh]. */
function findLongestMatch(
  a: string,
  b: string,
  al: number,
  ah: number,
  bl: number,
  bh: number,
): MatchingBlock {
  // Standard Ratcliff-Obershelp / SequenceMatcher.find_longest_match implementation.
  // Build b's char→positions index for the slice [bl, bh).
  const b2j = new Map<string, number[]>();
  for (let i = bl; i < bh; i++) {
    const ch = b[i]!;
    const list = b2j.get(ch);
    if (list) list.push(i);
    else b2j.set(ch, [i]);
  }

  let bestI = al;
  let bestJ = bl;
  let bestSize = 0;
  // j2len: position-in-b → length of match ending at (i, j).
  let j2len = new Map<number, number>();

  for (let i = al; i < ah; i++) {
    const newJ2len = new Map<number, number>();
    const positions = b2j.get(a[i]!) ?? [];
    for (const j of positions) {
      if (j < bl) continue;
      if (j >= bh) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newJ2len.set(j, k);
      if (k > bestSize) {
        bestI = i - k + 1;
        bestJ = j - k + 1;
        bestSize = k;
      }
    }
    j2len = newJ2len;
  }

  return { a: bestI, b: bestJ, size: bestSize };
}

/** Recursively collect matching blocks (gestalt pattern). */
function getMatchingBlocks(a: string, b: string): MatchingBlock[] {
  const blocks: MatchingBlock[] = [];
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];

  while (stack.length > 0) {
    const [al, ah, bl, bh] = stack.pop()!;
    const m = findLongestMatch(a, b, al, ah, bl, bh);
    if (m.size === 0) continue;

    blocks.push(m);
    if (al < m.a && bl < m.b) stack.push([al, m.a, bl, m.b]);
    if (m.a + m.size < ah && m.b + m.size < bh) {
      stack.push([m.a + m.size, ah, m.b + m.size, bh]);
    }
  }

  // Sort by a-position then merge adjacent blocks (Python's get_matching_blocks behavior).
  blocks.sort((x, y) => x.a - y.a || x.b - y.b);

  const merged: MatchingBlock[] = [];
  let cur: MatchingBlock | null = null;
  for (const blk of blocks) {
    if (cur && cur.a + cur.size === blk.a && cur.b + cur.size === blk.b) {
      cur.size += blk.size;
    } else {
      if (cur) merged.push(cur);
      cur = { ...blk };
    }
  }
  if (cur) merged.push(cur);

  return merged;
}

/**
 * Ratcliff-Obershelp similarity ratio ∈ [0, 1].
 *
 * Formula: `2 * matches / (len(a) + len(b))` where `matches` = total length
 * of matching blocks (sum of sizes). MemKraft `SequenceMatcher.ratio()` parity.
 *
 * Edge cases:
 * - both empty → 1.0 (Python parity: SequenceMatcher("", "").ratio() == 1.0)
 * - one empty → 0.0
 * - identical → 1.0
 */
export function similarityScore(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const blocks = getMatchingBlocks(a, b);
  let matches = 0;
  for (const blk of blocks) matches += blk.size;

  const denom = a.length + b.length;
  if (denom === 0) return 0.0;
  return (2 * matches) / denom;
}

/**
 * Lower-cased + whitespace-normalized comparison. Convenient for symptom
 * matching where casing/spacing should not affect score.
 */
export function similarityScoreFuzzy(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return similarityScore(norm(a), norm(b));
}
