/**
 * Git utilities — detect repo info for system prompt context.
 */

import { execSync } from "node:child_process";

export function getGitInfo(cwd: string): { branch: string; status: string } | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execSync("git status --short", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { branch, status: status || "(clean)" };
  } catch {
    return null;
  }
}
