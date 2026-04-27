/**
 * 5-dimensional critique framework — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * System + user prompt construction for the critique LLM call.
 * All prompt text below is written from scratch; no source text is copied
 * from the upstream project.
 */

const MAX_CONTENT_CHARS = 12000;

export const CRITIQUE_SYSTEM_PROMPT = `You evaluate creative work across 5 dimensions:

1. **Philosophy Alignment** — Does the work embody its stated intent and design philosophy?
2. **Visual Hierarchy** — Can the viewer's eye flow naturally to key information?
3. **Craft** — Pixel-perfect alignment, consistent spacing, color discipline.
4. **Functionality** — Does every element earn its place (zero decorative filler)?
5. **Originality** — Avoids generic patterns and clichés.

For each dimension, output a score (1-10) and a one-sentence reasoning.

Then provide:
- **Keep**: 3-5 strengths to preserve
- **Fix**: Issues categorized by severity (error/warning/optimization)
- **Quick Wins**: Top 3 highest-impact, fastest improvements

Respond with valid JSON matching the requested schema. Do not include any
commentary outside the JSON object.`;

export interface BuildCritiqueUserPromptParams {
  targetPath: string;
  content: string;
  philosophy?: string;
  context?: string;
}

/**
 * Truncate long inputs so we stay within model context budget.
 */
function truncate(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  return (
    content.slice(0, MAX_CONTENT_CHARS) +
    `\n\n... [truncated; ${content.length - MAX_CONTENT_CHARS} chars omitted]`
  );
}

export function buildCritiqueUserPrompt(
  params: BuildCritiqueUserPromptParams,
): string {
  const lines: string[] = [];
  lines.push(`Target file: ${params.targetPath}`);
  if (params.philosophy && params.philosophy.trim().length > 0) {
    lines.push(`Stated philosophy: ${params.philosophy.trim()}`);
  }
  if (params.context && params.context.trim().length > 0) {
    lines.push(`Additional context: ${params.context.trim()}`);
  }
  lines.push("");
  lines.push("Content:");
  lines.push("```");
  lines.push(truncate(params.content));
  lines.push("```");
  lines.push("");
  lines.push("Respond with JSON of this exact shape:");
  lines.push("{");
  lines.push('  "scores": [');
  lines.push('    {"dimension": "philosophy",        "score": 1-10, "reasoning": "..."},');
  lines.push('    {"dimension": "visual-hierarchy",  "score": 1-10, "reasoning": "..."},');
  lines.push('    {"dimension": "craft",             "score": 1-10, "reasoning": "..."},');
  lines.push('    {"dimension": "functionality",     "score": 1-10, "reasoning": "..."},');
  lines.push('    {"dimension": "originality",       "score": 1-10, "reasoning": "..."}');
  lines.push("  ],");
  lines.push('  "keep": ["strength 1", "strength 2", "strength 3"],');
  lines.push('  "fix": [{"severity": "error|warning|optimization", "issue": "...", "suggestion": "..."}],');
  lines.push('  "quickWins": ["win 1", "win 2", "win 3"]');
  lines.push("}");
  return lines.join("\n");
}
