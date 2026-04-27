/**
 * /critique handler — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Reads the target file, runs computeCritique, and renders a markdown report
 * with a 5-dimension radar, keep/fix/quick-wins sections, and overall score.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { computeCritique } from "../../agent/critique/engine.js";
import type {
  CritiqueFix,
  CritiqueResult,
  CritiqueScore,
} from "../../agent/critique/types.js";
import type { HandlerContext } from "./types.js";

const BAR_WIDTH = 10;

export interface CritiqueCommandData {
  path: string;
  philosophy?: string;
  strategy?: "llm" | "heuristic";
}

function renderBar(score: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(score)));
  const empty = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function severityIcon(severity: CritiqueFix["severity"]): string {
  if (severity === "error") return "ERROR";
  if (severity === "warning") return "WARNING";
  return "OPTIMIZATION";
}

function renderRadar(scores: CritiqueScore[]): string {
  const dimWidth = Math.max(
    ...scores.map((s) => s.dimension.length),
    "dimension".length,
  );
  const lines: string[] = [];
  for (const s of scores) {
    lines.push(
      `- ${padRight(s.dimension, dimWidth)}  ${renderBar(s.score)} ${s.score}/10  ${s.reasoning}`,
    );
  }
  return lines.join("\n");
}

function renderKeep(keep: string[]): string {
  if (keep.length === 0) return "## Keep\n- (none reported)";
  return ["## Keep", ...keep.map((k) => `- ${k}`)].join("\n");
}

function renderFix(fix: CritiqueFix[]): string {
  if (fix.length === 0) return "## Fix\n- (none reported)";
  const lines: string[] = ["## Fix"];
  for (const f of fix) {
    lines.push(`- ${severityIcon(f.severity)}: ${f.issue}`);
    lines.push(`    -> ${f.suggestion}`);
  }
  return lines.join("\n");
}

function renderQuickWins(wins: string[]): string {
  if (wins.length === 0) return "## Quick Wins\n- (none reported)";
  const lines: string[] = ["## Quick Wins"];
  wins.forEach((w, i) => lines.push(`${i + 1}. ${w}`));
  return lines.join("\n");
}

export function renderCritique(result: CritiqueResult): string {
  const header = [
    `# Critique: ${result.targetPath}`,
    `**Strategy**: ${result.strategy}  |  **Overall**: ${result.overallScore}/10`,
    "",
    "## Radar",
    renderRadar(result.scores),
    "",
    renderKeep(result.keep),
    "",
    renderFix(result.fix),
    "",
    renderQuickWins(result.quickWins),
  ];
  return header.join("\n");
}

export async function handleCritiqueCommand(
  data: CritiqueCommandData,
  context: HandlerContext,
): Promise<string> {
  if (!data?.path || !data.path.trim()) {
    return "Usage: /critique <file-path> [--philosophy NAME] [--strategy llm|heuristic]";
  }
  const rootDir = context.rootDir ?? process.cwd();
  const absolute = isAbsolute(data.path) ? data.path : resolve(rootDir, data.path);

  let content: string;
  try {
    content = readFileSync(absolute, "utf8");
  } catch (err) {
    return `Error: cannot read file ${data.path} — ${(err as Error).message}`;
  }

  const result = await computeCritique({
    targetPath: data.path,
    content,
    options: {
      philosophy: data.philosophy,
      strategy: data.strategy,
    },
  });

  return renderCritique(result);
}
