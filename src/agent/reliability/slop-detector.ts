/**
 * AI slop pattern detector — patterns adapted from huashu-design content guidelines.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Pattern descriptions and suggestions written independently.
 *
 * Aggregates SLOP_PATTERNS over a single content string and renders a
 * markdown report. Best-effort heuristic — surfaces signals only.
 */

import { SLOP_PATTERNS } from "./slop-patterns.js";

export interface SlopSignal {
  patternId: string;
  description: string;
  suggestion: string;
  severity: "warning" | "error";
  matchedText?: string;
  line?: number;
}

export function detectAISlopSignals(content: string): SlopSignal[] {
  if (!content) return [];
  const signals: SlopSignal[] = [];
  for (const pattern of SLOP_PATTERNS) {
    let match: ReturnType<typeof pattern.detect>;
    try {
      match = pattern.detect(content);
    } catch {
      continue;
    }
    if (!match) continue;
    signals.push({
      patternId: pattern.id,
      description: pattern.description,
      suggestion: pattern.suggestion,
      severity: pattern.severity,
      matchedText: match.matchedText,
      line: match.line,
    });
  }
  return signals;
}

export function formatSlopReport(signals: SlopSignal[]): string {
  if (signals.length === 0) {
    return "No obvious AI slop detected.";
  }
  const errorCount = signals.filter((s) => s.severity === "error").length;
  const warnCount = signals.length - errorCount;
  const headerBits: string[] = [];
  if (errorCount > 0) headerBits.push(`${errorCount} error(s)`);
  if (warnCount > 0) headerBits.push(`${warnCount} warning(s)`);
  const header = `Detected ${signals.length} AI-slop signal(s): ${headerBits.join(", ")}`;

  const blocks = signals.map((sig) => {
    const lines: string[] = [];
    lines.push(`${sig.severity.toUpperCase()} [${sig.patternId}]: ${sig.description}`);
    if (sig.matchedText) {
      lines.push(`  matched: ${sig.matchedText}`);
    }
    if (typeof sig.line === "number") {
      lines.push(`  line: ${sig.line}`);
    }
    lines.push(`  -> ${sig.suggestion}`);
    return lines.join("\n");
  });

  return [header, "", ...blocks].join("\n");
}
