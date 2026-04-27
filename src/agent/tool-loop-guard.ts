/**
 * Tool call loop guard — detects short repeating patterns in recent tool calls.
 *
 * This is intentionally conservative:
 * - It only flags short cycles of 2 or 3 tool names.
 * - It requires the same cycle to repeat at least twice.
 * - It ignores one-off chains and does not look at tool inputs.
 */

import { hashInput } from "./tool-call-dedup.js";

const DEFAULT_HISTORY_LIMIT = 12;
const MIN_CYCLE_LENGTH = 2;
const MAX_CYCLE_LENGTH = 3;
const MIN_REPEAT_COUNT = 2;

interface PatternMatch {
  cycleLength: number;
  repeatCount: number;
  pattern: string[];
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function uniqueCount(values: string[]): number {
  return new Set(values).size;
}

function findRepeatedSuffix(history: string[], cycleLength: number): PatternMatch | null {
  if (history.length < cycleLength * MIN_REPEAT_COUNT) {
    return null;
  }

  const pattern = history.slice(history.length - cycleLength);
  if (uniqueCount(pattern) < 2) {
    return null;
  }

  let repeatCount = 1;

  while (true) {
    const start = history.length - (repeatCount + 1) * cycleLength;
    if (start < 0) break;

    const slice = history.slice(start, start + cycleLength);
    if (!arraysEqual(slice, pattern)) {
      break;
    }

    repeatCount += 1;
  }

  if (repeatCount < MIN_REPEAT_COUNT) {
    return null;
  }

  return { cycleLength, repeatCount, pattern };
}

export interface ToolLoopGuardResult {
  triggered: boolean;
  toolName: string;
  inputHash: string;
  consecutiveCount: number;
  threshold: number;
  message?: string;
  cycleLength?: number;
  pattern?: string[];
}

export class ToolCallPatternGuard {
  private readonly historyLimit: number;
  private readonly history: string[] = [];

  constructor(historyLimit = DEFAULT_HISTORY_LIMIT) {
    this.historyLimit = historyLimit;
  }

  record(toolName: string): ToolLoopGuardResult {
    this.history.push(toolName);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }

    for (let cycleLength = MAX_CYCLE_LENGTH; cycleLength >= MIN_CYCLE_LENGTH; cycleLength--) {
      const match = findRepeatedSuffix(this.history, cycleLength);
      if (!match) continue;

      const patternLabel = match.pattern.join(" → ");
      const patternHash = hashInput({
        pattern: match.pattern,
        cycleLength: match.cycleLength,
        repeatCount: match.repeatCount,
      });

      return {
        triggered: true,
        toolName,
        inputHash: patternHash,
        consecutiveCount: match.repeatCount,
        threshold: MIN_REPEAT_COUNT,
        message:
          `Detected a repeating tool pattern: ${patternLabel} repeated ${match.repeatCount} times. ` +
          "Try a different approach.",
        cycleLength: match.cycleLength,
        pattern: match.pattern,
      };
    }

    return {
      triggered: false,
      toolName,
      inputHash: hashInput({ toolName, historyLength: this.history.length }),
      consecutiveCount: 1,
      threshold: MIN_REPEAT_COUNT,
    };
  }

  reset(): void {
    this.history.length = 0;
  }
}
