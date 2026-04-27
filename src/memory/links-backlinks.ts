/**
 * Wiki Link Backlinks (Wave 10 F4) — bidirectional companion to forward.json.
 *
 * Stores `<linksDir>/backlinks.json` mapping `entity → [filePath, ...]` (the
 * inverse of forward.json). Built by `rebuildBacklinks()` immediately after
 * `linkScan` writes the forward index. Atomic write (tmp+rename) under the
 * same `acquireFileLockSync` used for forward.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { acquireFileLockSync } from "./file-lock.js";
import type { ForwardIndex } from "./links-types.js";
import type { ProjectMemoryCore } from "./types.js";

const BACKLINKS_FILENAME = "backlinks.json";
const BACKLINKS_TMP_FILENAME = "backlinks.json.tmp";
const FORWARD_FILENAME = "forward.json";

/** Backlinks index: entity name → array of file paths that reference it via [[Entity]]. */
export interface BacklinksIndex {
  [entity: string]: string[];
}

function linksDir(projectMemory: ProjectMemoryCore): string {
  return join(projectMemory.memoryDir, "links");
}

function backlinksPath(projectMemory: ProjectMemoryCore): string {
  return join(linksDir(projectMemory), BACKLINKS_FILENAME);
}

function backlinksTmpPath(projectMemory: ProjectMemoryCore): string {
  return join(linksDir(projectMemory), BACKLINKS_TMP_FILENAME);
}

function forwardPath(projectMemory: ProjectMemoryCore): string {
  return join(linksDir(projectMemory), FORWARD_FILENAME);
}

function ensureLinksDirSync(projectMemory: ProjectMemoryCore): void {
  const dir = linksDir(projectMemory);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadForward(projectMemory: ProjectMemoryCore): ForwardIndex {
  const f = forwardPath(projectMemory);
  if (!existsSync(f)) return {};
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ForwardIndex = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        out[k] = v as string[];
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read existing backlinks.json. Returns `{}` if missing or corrupt — corrupt
 * file is tolerated silently so reads never block on a malformed index. A
 * subsequent `rebuildBacklinks` (called by `linkScan`) will regenerate it.
 */
export function readBacklinks(projectMemory: ProjectMemoryCore): BacklinksIndex {
  const f = backlinksPath(projectMemory);
  if (!existsSync(f)) return {};
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // eslint-disable-next-line no-console
      console.warn(`[links-backlinks] Corrupt backlinks.json at ${f} — treating as empty.`);
      return {};
    }
    const out: BacklinksIndex = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        out[k] = v as string[];
      }
    }
    return out;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[links-backlinks] Failed to parse backlinks.json at ${f} — treating as empty.`);
    return {};
  }
}

/** Lookup which files reference the given entity. Sorted, deduplicated. */
export function linkBacklinks(projectMemory: ProjectMemoryCore, entity: string): string[] {
  const idx = readBacklinks(projectMemory);
  const arr = idx[entity] ?? [];
  return Array.from(new Set(arr)).sort();
}

/** Build backlinks index from a forward index — pure function, no I/O. */
export function inverseForward(forward: ForwardIndex): BacklinksIndex {
  const back: BacklinksIndex = {};
  for (const [file, targets] of Object.entries(forward)) {
    for (const ent of targets) {
      const list = back[ent] ?? (back[ent] = []);
      list.push(file);
    }
  }
  // canonicalize: dedup + sort
  for (const k of Object.keys(back)) {
    back[k] = Array.from(new Set(back[k] ?? [])).sort();
  }
  return back;
}

/**
 * Build backlinks.json from forward.json (inverse mapping). Atomic tmp+rename
 * under exclusive file lock (R1). Caller-side: invoked from `linkScan` after
 * forward.json is written.
 */
export function rebuildBacklinks(projectMemory: ProjectMemoryCore): {
  written: boolean;
  entityCount: number;
  error?: string;
} {
  ensureLinksDirSync(projectMemory);
  const finalPath = backlinksPath(projectMemory);
  const tmpPath = backlinksTmpPath(projectMemory);

  const forward = loadForward(projectMemory);
  const back = inverseForward(forward);

  // canonicalize key order for deterministic output
  const sortedKeys = Object.keys(back).sort();
  const canonical: BacklinksIndex = {};
  for (const k of sortedKeys) {
    canonical[k] = back[k] ?? [];
  }

  const lock = acquireFileLockSync(finalPath, { timeoutMs: 5000 });
  try {
    writeFileSync(tmpPath, JSON.stringify(canonical, null, 2), "utf-8");
    renameSync(tmpPath, finalPath);
    return { written: true, entityCount: sortedKeys.length };
  } catch (err) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    } catch {
      /* swallow */
    }
    return {
      written: false,
      entityCount: sortedKeys.length,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    lock.release();
  }
}
