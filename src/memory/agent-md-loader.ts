/**
 * Loader for AGENT.md / CLAUDE.md instructions.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { AGENT_MD_FILENAMES, MAX_AGENT_MD_FILE_BYTES, MAX_AGENT_MD_TOTAL_BYTES } from "./constants.js";
import type { AgentMdFile } from "./types.js";

function isWithinHomeDirectory(cwd: string): boolean {
  const home = resolve(homedir());
  const candidate = resolve(cwd);
  if (candidate === home) {
    return true;
  }
  const rel = relative(home, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function readAgentMdFile(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    const raw = readFileSync(filePath);

    if (stats.size > MAX_AGENT_MD_FILE_BYTES) {
      return `${raw.subarray(0, MAX_AGENT_MD_FILE_BYTES).toString("utf8")}\n\n[Truncated to ${MAX_AGENT_MD_FILE_BYTES} bytes]`;
    }

    return raw.toString("utf8");
  } catch (error) {
    console.warn(`[memory] skipping unreadable file: ${filePath} (${(error as Error).message})`);
    return null;
  }
}

export function findAgentMd(cwd: string): AgentMdFile[] {
  if (!cwd || !cwd.trim()) {
    return [];
  }

  const resolvedStart = resolve(cwd);
  const files: AgentMdFile[] = [];
  const seen = new Set<string>();
  let currentDir = resolvedStart;
  let totalBytes = 0;

  while (true) {
    for (const filename of AGENT_MD_FILENAMES) {
      const filePath = resolve(currentDir, filename);
      if (!existsSync(filePath) || seen.has(filePath)) {
        continue;
      }

      const content = readAgentMdFile(filePath);
      if (content == null) {
        continue;
      }

      let nextContent = content;
      const bytes = Buffer.byteLength(nextContent, "utf8");
      if (totalBytes + bytes > MAX_AGENT_MD_TOTAL_BYTES) {
        const remaining = Math.max(0, MAX_AGENT_MD_TOTAL_BYTES - totalBytes);
        if (remaining === 0) {
          return files;
        }
        nextContent = Buffer.from(nextContent, "utf8").subarray(0, remaining).toString("utf8");
        nextContent += `\n\n[Truncated to ${MAX_AGENT_MD_TOTAL_BYTES} bytes total]`;
        totalBytes = MAX_AGENT_MD_TOTAL_BYTES;
        files.push({ path: filePath, content: nextContent });
        return files;
      }

      files.push({ path: filePath, content: nextContent });
      seen.add(filePath);
      totalBytes += bytes;
    }

    if (existsSync(resolve(currentDir, ".git"))) {
      break;
    }

    const parent = dirname(currentDir);
    if (parent === currentDir) {
      break;
    }

    if (isWithinHomeDirectory(resolvedStart) && !isWithinHomeDirectory(parent)) {
      break;
    }

    currentDir = parent;
  }

  return files;
}

export function loadAgentMdContent(files: AgentMdFile[]): string {
  if (files.length === 0) {
    return "";
  }

  return files
    .map((file) => `--- ${file.path} ---\n${file.content}`.trimEnd())
    .join("\n\n");
}

export function loadProjectInstructions(cwd: string): string {
  return loadAgentMdContent(findAgentMd(cwd));
}
