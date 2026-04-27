/**
 * Project id helpers — deterministic cwd hashing and metadata tracking.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getProjectDir, getProjectMemoryDir } from "../config/paths.js";
import type { ProjectMetadata } from "./types.js";

export function getProjectId(cwd: string): string {
  if (!cwd || !cwd.trim()) {
    throw new Error("cwd is required");
  }
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

export function getProjectMetadataPath(projectId: string, rootDir?: string): string {
  return join(getProjectDir(projectId, rootDir), "metadata.json");
}

export function readProjectMetadata(projectId: string, rootDir?: string): ProjectMetadata | null {
  const metadataPath = getProjectMetadataPath(projectId, rootDir);
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    const raw = readFileSync(metadataPath, "utf-8");
    return JSON.parse(raw) as ProjectMetadata;
  } catch {
    return null;
  }
}

export function writeProjectMetadata(
  cwd: string,
  rootDir?: string,
  timestamp: Date = new Date(),
): ProjectMetadata {
  const resolvedCwd = resolve(cwd);
  const projectId = getProjectId(resolvedCwd);
  const projectDir = getProjectDir(projectId, rootDir);
  const memoryDir = getProjectMemoryDir(projectId, rootDir);

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });

  const existing = readProjectMetadata(projectId, rootDir);
  const metadata: ProjectMetadata = {
    cwd: resolvedCwd,
    projectId,
    createdAt: existing?.createdAt ?? timestamp.toISOString(),
    lastAccessedAt: timestamp.toISOString(),
  };

  writeFileSync(getProjectMetadataPath(projectId, rootDir), JSON.stringify(metadata, null, 2) + "\n");
  return metadata;
}

export function ensureProjectMetadata(cwd: string, rootDir?: string): ProjectMetadata {
  return writeProjectMetadata(resolve(cwd), rootDir);
}
