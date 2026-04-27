/**
 * /slop-check handler — patterns adapted from huashu-design content guidelines.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Pattern descriptions and suggestions written independently.
 *
 * Reads a file from disk and returns a markdown slop report. Resolves the
 * path against the optional `cwd` argument, falling back to process.cwd().
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  detectAISlopSignals,
  formatSlopReport,
} from "../../agent/reliability/slop-detector.js";

export interface SlopCheckCommandData {
  path: string;
}

export interface SlopHandlerContext {
  cwd?: string;
}

export async function handleSlopCheck(
  data: SlopCheckCommandData,
  context: SlopHandlerContext = {},
): Promise<string> {
  const target = data?.path?.trim();
  if (!target) return "Usage: /slop-check <file-path>";

  const baseCwd = context.cwd ?? process.cwd();
  const resolved = isAbsolute(target) ? target : resolve(baseCwd, target);

  let content: string;
  try {
    content = readFileSync(resolved, "utf-8");
  } catch (err) {
    return `Error: cannot read file ${resolved}: ${(err as Error).message}`;
  }

  const signals = detectAISlopSignals(content);
  const report = formatSlopReport(signals);
  return `Slop check: ${resolved}\n\n${report}`;
}
