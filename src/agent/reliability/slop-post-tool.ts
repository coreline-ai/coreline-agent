/**
 * PostTool hook for AI slop detection — patterns adapted from huashu-design content guidelines.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Pattern descriptions and suggestions written independently.
 *
 * Best-effort, non-invasive: scans FileWrite/FileEdit/MultiEdit tool inputs
 * that look like HTML/CSS and returns SlopSignal[] for inclusion in metadata.
 * Never mutates content. Disabled with SLOP_DETECT_ENABLE=false.
 */

import { detectAISlopSignals, type SlopSignal } from "./slop-detector.js";

const TARGET_TOOLS = new Set(["FileWrite", "FileEdit", "MultiEdit"]);
const HTML_CSS_HINT = /<html|<style|class=|font-family|linear-gradient|border-radius/;

export function shouldRunSlopDetection(toolName: string, content: string): boolean {
  if (process.env.SLOP_DETECT_ENABLE === "false") return false;
  if (!TARGET_TOOLS.has(toolName)) return false;
  if (!content) return false;
  if (!HTML_CSS_HINT.test(content)) return false;
  return true;
}

export function attachSlopMetadata(
  toolName: string,
  content: string,
): SlopSignal[] {
  if (!shouldRunSlopDetection(toolName, content)) return [];
  return detectAISlopSignals(content);
}
