/**
 * 5-dimensional critique framework — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Deterministic heuristic critique. Used when the LLM strategy is disabled
 * or when the LLM call fails. Scores are best-effort static estimates only.
 */

import type {
  CritiqueDimension,
  CritiqueFix,
  CritiqueResult,
  CritiqueScore,
} from "./types.js";

interface HeuristicMetrics {
  lineCount: number;
  headingCount: number;
  headingDiversity: number; // distinct heading levels h1/h2/h3
  colorCount: number;
  fontCount: number;
  assetCount: number;
}

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_COLOR_RE = /\brgb[a]?\(\s*\d+/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;"'\n]+)/gi;
const ASSET_RE = /<(img|video|svg|picture|source)[^>]*>/gi;

function collectMetrics(content: string): HeuristicMetrics {
  const lines = content.split(/\r?\n/);
  const lineCount = lines.length;

  const headingsByLevel = new Set<string>();
  let headingCount = 0;
  for (const m of content.matchAll(/<(h[1-6])\b/gi)) {
    headingCount += 1;
    headingsByLevel.add(m[1]!.toLowerCase());
  }

  const colors = new Set<string>();
  for (const m of content.match(HEX_COLOR_RE) ?? []) {
    colors.add(m.toLowerCase());
  }
  for (const m of content.match(RGB_COLOR_RE) ?? []) {
    colors.add(m.toLowerCase());
  }

  const fonts = new Set<string>();
  for (const m of content.matchAll(FONT_FAMILY_RE)) {
    const value = (m[1] ?? "").trim().toLowerCase();
    if (value) fonts.add(value);
  }

  const assets = (content.match(ASSET_RE) ?? []).length;

  return {
    lineCount,
    headingCount,
    headingDiversity: headingsByLevel.size,
    colorCount: colors.size,
    fontCount: fonts.size,
    assetCount: assets,
  };
}

function scorePhilosophy(): CritiqueScore {
  return {
    dimension: "philosophy",
    score: 7,
    reasoning:
      "Heuristic baseline — philosophy alignment cannot be evaluated without an LLM judgment.",
  };
}

function scoreHierarchy(metrics: HeuristicMetrics): CritiqueScore {
  let score: number;
  let reasoning: string;
  if (metrics.headingDiversity >= 3) {
    score = 8;
    reasoning = `Headings span ${metrics.headingDiversity} levels — strong vertical hierarchy.`;
  } else if (metrics.headingDiversity === 2) {
    score = 7;
    reasoning = "Two heading levels detected — adequate hierarchy.";
  } else if (metrics.headingCount >= 1) {
    score = 5;
    reasoning = "Single heading level only — hierarchy could be richer.";
  } else {
    score = 4;
    reasoning = "No structural headings detected — hierarchy is flat.";
  }
  return { dimension: "visual-hierarchy", score, reasoning };
}

function scoreCraft(metrics: HeuristicMetrics): CritiqueScore {
  let score: number;
  let reasoning: string;
  if (metrics.colorCount <= 4 && metrics.fontCount <= 2) {
    score = 8;
    reasoning = `Disciplined palette (${metrics.colorCount} colors, ${metrics.fontCount} fonts).`;
  } else if (metrics.colorCount <= 6 && metrics.fontCount <= 3) {
    score = 7;
    reasoning = `Moderate palette (${metrics.colorCount} colors, ${metrics.fontCount} fonts).`;
  } else {
    score = 5;
    reasoning = `Palette feels noisy (${metrics.colorCount} colors, ${metrics.fontCount} fonts).`;
  }
  return { dimension: "craft", score, reasoning };
}

function scoreFunctionality(metrics: HeuristicMetrics): CritiqueScore {
  // Heuristic: high line count with low asset/heading density suggests filler.
  const meaningful = metrics.headingCount + metrics.assetCount;
  if (metrics.lineCount === 0) {
    return {
      dimension: "functionality",
      score: 5,
      reasoning: "Empty content — cannot evaluate functional density.",
    };
  }
  const ratio = meaningful / Math.max(1, metrics.lineCount / 50);
  let score: number;
  let reasoning: string;
  if (ratio >= 1.5) {
    score = 8;
    reasoning = "Each section appears to carry structural weight.";
  } else if (ratio >= 0.8) {
    score = 7;
    reasoning = "Most sections appear purposeful.";
  } else {
    score = 6;
    reasoning = "Some sections may be decorative — consider tightening.";
  }
  return { dimension: "functionality", score, reasoning };
}

function scoreOriginality(): CritiqueScore {
  return {
    dimension: "originality",
    score: 7,
    reasoning:
      "Heuristic baseline — originality requires comparative judgment beyond static analysis.",
  };
}

function buildKeep(metrics: HeuristicMetrics): string[] {
  const keep: string[] = [];
  if (metrics.headingDiversity >= 2) {
    keep.push("Multi-level heading structure aids scannability.");
  }
  if (metrics.colorCount > 0 && metrics.colorCount <= 4) {
    keep.push("Restrained color palette — good discipline.");
  }
  if (metrics.fontCount > 0 && metrics.fontCount <= 2) {
    keep.push("Tight font selection avoids visual noise.");
  }
  if (keep.length === 0) {
    keep.push("Baseline structure is in place.");
    keep.push("Content is parseable as a single document.");
  }
  if (keep.length < 3) {
    keep.push("Headings, palette, and typography decisions are explicit.");
  }
  return keep.slice(0, 5);
}

function buildFix(metrics: HeuristicMetrics): CritiqueFix[] {
  const fixes: CritiqueFix[] = [];
  if (metrics.colorCount > 6) {
    fixes.push({
      severity: "warning",
      issue: `Color palette is broad (${metrics.colorCount} distinct colors).`,
      suggestion: "Consolidate to 3-5 core colors plus neutrals.",
    });
  }
  if (metrics.fontCount > 3) {
    fixes.push({
      severity: "warning",
      issue: `Multiple font families detected (${metrics.fontCount}).`,
      suggestion: "Standardize on one body + one display font.",
    });
  }
  if (metrics.headingCount === 0) {
    fixes.push({
      severity: "error",
      issue: "No structural headings present.",
      suggestion: "Introduce h1/h2/h3 to establish hierarchy.",
    });
  }
  if (metrics.headingDiversity === 1 && metrics.headingCount > 5) {
    fixes.push({
      severity: "optimization",
      issue: "All headings share a single level.",
      suggestion: "Promote section titles to a higher level for contrast.",
    });
  }
  if (fixes.length === 0) {
    fixes.push({
      severity: "optimization",
      issue: "Heuristic check found no obvious issues.",
      suggestion: "Re-run with the LLM strategy for substantive critique.",
    });
  }
  return fixes;
}

function buildQuickWins(metrics: HeuristicMetrics): string[] {
  const wins: string[] = [];
  if (metrics.colorCount > 5) {
    wins.push(`Reduce color palette (${metrics.colorCount} → 3-4).`);
  }
  if (metrics.fontCount > 2) {
    wins.push(`Cut font families (${metrics.fontCount} → 2).`);
  }
  if (metrics.headingDiversity < 2) {
    wins.push("Add a second heading level to break up flat sections.");
  }
  while (wins.length < 3) {
    if (!wins.includes("Audit spacing tokens for consistency.")) {
      wins.push("Audit spacing tokens for consistency.");
    } else if (!wins.includes("Verify focus-visible styles on interactives.")) {
      wins.push("Verify focus-visible styles on interactives.");
    } else {
      wins.push("Run a full LLM critique for deeper feedback.");
      break;
    }
  }
  return wins.slice(0, 3);
}

function averageScore(scores: CritiqueScore[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((acc, s) => acc + s.score, 0);
  return Math.round((sum / scores.length) * 10) / 10;
}

export interface ComputeHeuristicCritiqueParams {
  targetPath: string;
  content: string;
}

export function computeHeuristicCritique(
  params: ComputeHeuristicCritiqueParams,
): CritiqueResult {
  const metrics = collectMetrics(params.content);
  const scores: CritiqueScore[] = [
    scorePhilosophy(),
    scoreHierarchy(metrics),
    scoreCraft(metrics),
    scoreFunctionality(metrics),
    scoreOriginality(),
  ];
  // Sanity: ensure exactly the canonical dimension order.
  const _expected: CritiqueDimension[] = [
    "philosophy",
    "visual-hierarchy",
    "craft",
    "functionality",
    "originality",
  ];
  void _expected;
  return {
    targetPath: params.targetPath,
    overallScore: averageScore(scores),
    scores,
    keep: buildKeep(metrics),
    fix: buildFix(metrics),
    quickWins: buildQuickWins(metrics),
    strategy: "heuristic",
  };
}
