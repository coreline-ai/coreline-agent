/**
 * 5-dimensional critique framework — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Type definitions for the critique engine: 5 dimensions
 * (philosophy, visual-hierarchy, craft, functionality, originality),
 * scored on a 1-10 scale with reasoning, plus keep/fix/quickWins outputs.
 */

export const CRITIQUE_DIMENSIONS = [
  "philosophy",
  "visual-hierarchy",
  "craft",
  "functionality",
  "originality",
] as const;

export type CritiqueDimension = (typeof CRITIQUE_DIMENSIONS)[number];

export interface CritiqueScore {
  dimension: CritiqueDimension;
  /** 1-10 inclusive. */
  score: number;
  /** 1-2 sentence rationale. */
  reasoning: string;
}

export type CritiqueFixSeverity = "error" | "warning" | "optimization";

export interface CritiqueFix {
  severity: CritiqueFixSeverity;
  issue: string;
  suggestion: string;
}

export interface CritiqueResult {
  targetPath: string;
  /** Average of the 5 dimension scores (rounded to 1 decimal). */
  overallScore: number;
  scores: CritiqueScore[];
  /** Strengths to preserve (3-5 items). */
  keep: string[];
  fix: CritiqueFix[];
  /** Top-3 fastest, highest-impact improvements. */
  quickWins: string[];
  /** Which engine produced this result. */
  strategy: "llm" | "heuristic";
}

export interface CritiqueOptions {
  /** Optional design philosophy label (e.g. "minimal", "brutalist"). */
  philosophy?: string;
  /** Optional free-form context appended to the prompt. */
  context?: string;
  /** Force a strategy. Default "llm" with heuristic fallback. */
  strategy?: "llm" | "heuristic";
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}
