/**
 * Tool call deduplication — detects repeated identical tool calls.
 */

import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]);
    return Object.fromEntries(sortedEntries);
  }

  return value;
}

export function hashInput(input: Record<string, unknown>): string {
  const canonicalJson = JSON.stringify(canonicalize(input));
  return createHash("sha256").update(canonicalJson).digest("hex").slice(0, 8);
}

export interface ToolCallRecordResult {
  isDuplicate: boolean;
  consecutiveCount: number;
}

export class ToolCallDedup {
  constructor(private readonly duplicateThreshold = 3) {}

  private lastSignature: string | null = null;
  private consecutiveCount = 0;

  record(toolName: string, inputHash: string): ToolCallRecordResult {
    const signature = `${toolName}:${inputHash}`;

    if (signature === this.lastSignature) {
      this.consecutiveCount += 1;
    } else {
      this.lastSignature = signature;
      this.consecutiveCount = 1;
    }

    return {
      isDuplicate: this.consecutiveCount > this.duplicateThreshold,
      consecutiveCount: this.consecutiveCount,
    };
  }

  reset(): void {
    this.lastSignature = null;
    this.consecutiveCount = 0;
  }
}
