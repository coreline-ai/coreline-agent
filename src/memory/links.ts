/**
 * Wiki Link Graph (Wave 7 Phase 3) — forward-only MVP.
 *
 * Ports MemKraft [links.py](../../../memkraft/src/memkraft/links.py) but stores ONLY the
 * forward index (`<memoryDir>/links/forward.json`). Backlinks (`backlinks.json`) and
 * `linkBacklinks()` are deferred to Wave 10+ per dev-plan D3.
 *
 * Wiki link grammar: `[[Entity Name]]` or `[[Entity|display]]`. Code fences and
 * frontmatter are excluded from extraction.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { LINK_MAX_HOPS, MEMORY_INDEX_FILE } from "./constants.js";
import { acquireFileLockSync } from "./file-lock.js";
import { readBacklinks, rebuildBacklinks } from "./links-backlinks.js";
import type { ForwardIndex, LinkGraphNode, LinkScanResult } from "./links-types.js";
import type { ProjectMemoryCore } from "./types.js";

const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g;
const FORWARD_FILENAME = "forward.json";
const FORWARD_TMP_FILENAME = "forward.json.tmp";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function linksDir(projectMemory: ProjectMemoryCore): string {
  return join(projectMemory.memoryDir, "links");
}

function forwardPath(projectMemory: ProjectMemoryCore): string {
  return join(linksDir(projectMemory), FORWARD_FILENAME);
}

function forwardTmpPath(projectMemory: ProjectMemoryCore): string {
  return join(linksDir(projectMemory), FORWARD_TMP_FILENAME);
}

function ensureLinksDirSync(projectMemory: ProjectMemoryCore): string {
  const dir = linksDir(projectMemory);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadForward(projectMemory: ProjectMemoryCore): ForwardIndex {
  const f = forwardPath(projectMemory);
  if (!existsSync(f)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
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

/** Atomically write forward index — write tmp + rename. Best-effort cleanup on failure. */
function writeForward(projectMemory: ProjectMemoryCore, index: ForwardIndex): { written: boolean; error?: string } {
  ensureLinksDirSync(projectMemory);
  const finalPath = forwardPath(projectMemory);
  const tmpPath = forwardTmpPath(projectMemory);

  // canonicalize: sort keys + sort entity arrays (dedup) for deterministic output
  const sortedKeys = Object.keys(index).sort();
  const canonical: ForwardIndex = {};
  for (const k of sortedKeys) {
    const arr = index[k];
    if (!arr || arr.length === 0) {
      continue;
    }
    canonical[k] = Array.from(new Set(arr)).sort();
  }

  // R1: serialize concurrent writers via cross-process file lock.
  const lock = acquireFileLockSync(finalPath, { timeoutMs: 5000 });
  try {
    writeFileSync(tmpPath, JSON.stringify(canonical, null, 2), "utf-8");
    renameSync(tmpPath, finalPath);
    return { written: true };
  } catch (err) {
    // best-effort cleanup of stale tmp
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    } catch {
      /* swallow */
    }
    return { written: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

/** Strip frontmatter (only AFTER closing `---`) and triple-backtick code fences. */
function stripExtractionExclusions(text: string): string {
  let body = text;

  // Strip leading frontmatter block: starts with `---` on first line
  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    // find closing `---` on its own line
    const lines = body.split(/\r?\n/);
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        close = i;
        break;
      }
    }
    if (close > 0) {
      body = lines.slice(close + 1).join("\n");
    }
  }

  // Strip triple-backtick code fences. Naive but sufficient: alternate fence regions.
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

/** Extract deduplicated, order-preserving wiki-link target names from text. */
export function extractLinks(text: string): string[] {
  const stripped = stripExtractionExclusions(text);
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(stripped)) !== null) {
    const raw = (m[1] ?? "").trim();
    if (!raw) continue;
    const target = (raw.split("|", 1)[0] ?? "").trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// memory file enumeration
// ---------------------------------------------------------------------------

/**
 * Walk `memoryDir` for `*.md` files, skipping internal management subdirs
 * (`.memory/`, `links/`).
 */
function* iterMemoryFiles(memoryDir: string, root?: string): Generator<string> {
  if (!existsSync(memoryDir)) return;
  const start = root ? resolve(memoryDir, root) : memoryDir;
  if (!existsSync(start)) return;

  const stat = statSync(start);
  if (stat.isFile()) {
    if (start.endsWith(".md")) yield start;
    return;
  }

  const stack: string[] = [start];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // skip internal management trees
        if (name === "links" || name === ".memory" || name === ".memkraft") {
          continue;
        }
        stack.push(full);
      } else if (st.isFile() && name.endsWith(".md")) {
        yield full;
      }
    }
  }
}

function relPath(memoryDir: string, abs: string): string {
  const r = relative(memoryDir, abs);
  // normalize to forward slashes for cross-platform stable storage
  return r.split(/[\\]/g).join("/");
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Full or incremental rescan. When `path` is undefined, rebuild the entire
 * forward index by walking `memoryDir`. When `path` is supplied, only that
 * file (relative to `memoryDir`) is re-extracted and merged onto the existing
 * index. Atomic write via tmp+rename.
 */
export function linkScan(projectMemory: ProjectMemoryCore, path?: string): LinkScanResult {
  const memoryDir = projectMemory.memoryDir;
  const fullRescan = path === undefined;

  let index: ForwardIndex = {};
  if (!fullRescan) {
    index = loadForward(projectMemory);
  }

  let filesScanned = 0;

  if (fullRescan) {
    const built: ForwardIndex = {};
    for (const abs of iterMemoryFiles(memoryDir)) {
      // exclude MEMORY.md auto-digest at memory dir root
      if (basename(abs) === MEMORY_INDEX_FILE) continue;
      filesScanned++;
      let text: string;
      try {
        text = readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      const targets = extractLinks(text);
      const rel = relPath(memoryDir, abs);
      if (targets.length > 0) {
        built[rel] = targets;
      }
    }
    index = built;
  } else {
    // incremental: re-extract a single file path
    const abs = resolve(memoryDir, path);
    const rel = relPath(memoryDir, abs);
    if (existsSync(abs)) {
      filesScanned = 1;
      try {
        const text = readFileSync(abs, "utf-8");
        const targets = extractLinks(text);
        if (targets.length > 0) {
          index[rel] = targets;
        } else {
          delete index[rel];
        }
      } catch {
        // unreadable — leave existing entry untouched
      }
    } else {
      // file removed — drop from index
      delete index[rel];
    }
  }

  const entitiesLinked = new Set<string>();
  for (const targets of Object.values(index)) {
    for (const t of targets) entitiesLinked.add(t);
  }

  const writeRes = writeForward(projectMemory, index);

  // F4: rebuild backlinks.json alongside forward.json. Failure is non-fatal —
  // backlinks are an inverse view; linkScan still reports forward write status.
  if (writeRes.written) {
    rebuildBacklinks(projectMemory);
  }

  return {
    filesScanned,
    entitiesLinked: entitiesLinked.size,
    written: writeRes.written,
    ...(writeRes.error ? { error: writeRes.error } : {}),
  };
}

/** Entities referenced from `source` (relative path from memoryDir). */
export function linkForward(projectMemory: ProjectMemoryCore, source: string): string[] {
  let index = loadForward(projectMemory);
  if (Object.keys(index).length === 0) {
    linkScan(projectMemory);
    index = loadForward(projectMemory);
  }
  // normalize separator
  const key = source.split(/[\\]/g).join("/");
  return [...(index[key] ?? [])];
}

/**
 * BFS link graph rooted at `entity`. Each hop:
 *   1. Find files (forward keys) that reference current entity → emit edge (file → entity).
 *   2. From those files, follow other entities → emit edges (file → otherEntity); enqueue otherEntity.
 *   3. Also walk the file as a graph node (so file→file paths in 2-hop work).
 *
 * Cycles are prevented by a `seen` set on entities + files. `hops` is capped at
 * `LINK_MAX_HOPS`.
 */
export function linkGraph(
  projectMemory: ProjectMemoryCore,
  entity: string,
  opts?: { hops?: number; direction?: "forward" | "backward" | "both" },
): LinkGraphNode {
  const requested = opts?.hops ?? 1;
  if (requested < 1) {
    throw new Error("hops must be >= 1");
  }
  const hops = Math.min(requested, LINK_MAX_HOPS);
  const direction = opts?.direction ?? "forward";

  let index = loadForward(projectMemory);
  if (Object.keys(index).length === 0) {
    linkScan(projectMemory);
    index = loadForward(projectMemory);
  }

  // Build backlinks view lazily for backward / both. (F4)
  const backlinks = direction === "forward" ? null : readBacklinks(projectMemory);
  const includeForward = direction === "forward" || direction === "both";
  const includeBackward = direction === "backward" || direction === "both";

  const nodes = new Set<string>([entity]);
  const edges = new Set<string>(); // serialized "src dst" for set semantics
  const seen = new Set<string>([entity]);
  const queue: Array<{ node: string; depth: number }> = [{ node: entity, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { node, depth } = item;
    if (depth >= hops) continue;

    if (includeForward) {
    // find files mentioning this entity
    for (const [src, targets] of Object.entries(index)) {
      if (!targets.includes(node)) continue;
      // edge from file → entity
      edges.add(`${src} ${node}`);
      nodes.add(src);
      // enqueue the file-as-node so we expand its entities at next depth
      if (!seen.has(src)) {
        seen.add(src);
        queue.push({ node: src, depth: depth + 1 });
      }
      // also enqueue co-mentioned entities at next depth
      for (const other of targets) {
        if (other === node) continue;
        edges.add(`${src} ${other}`);
        if (!seen.has(other)) {
          seen.add(other);
          nodes.add(other);
          queue.push({ node: other, depth: depth + 1 });
        }
      }
    }

    // node may itself be a file path (when reached via expansion above) — expand its entities
    // Also: if `node` is a bare entity name AND a `<entity>.md` definition file exists,
    // include that file's outbound links (the entity's own forward references).
    if (!node.endsWith(".md")) {
      const selfFile = `${node}.md`;
      const selfTargets = index[selfFile];
      if (selfTargets) {
        nodes.add(selfFile);
        edges.add(`${selfFile} ${node}`);
        for (const tgt of selfTargets) {
          edges.add(`${selfFile} ${tgt}`);
          if (!seen.has(tgt)) {
            seen.add(tgt);
            nodes.add(tgt);
            queue.push({ node: tgt, depth: depth + 1 });
          }
        }
        if (!seen.has(selfFile)) {
          seen.add(selfFile);
          queue.push({ node: selfFile, depth: depth + 1 });
        }
      }
    }
    const fwTargets = index[node];
    if (fwTargets) {
      for (const tgt of fwTargets) {
        edges.add(`${node} ${tgt}`);
        if (!seen.has(tgt)) {
          seen.add(tgt);
          nodes.add(tgt);
          queue.push({ node: tgt, depth: depth + 1 });
        }
      }
    }
    } // end if (includeForward)

    if (includeBackward && backlinks) {
      // Backward traversal: backlinks[node] = files referencing `node`.
      const refs = backlinks[node];
      if (refs) {
        for (const src of refs) {
          edges.add(`${src} ${node}`);
          nodes.add(src);
          if (!seen.has(src)) {
            seen.add(src);
            queue.push({ node: src, depth: depth + 1 });
          }
        }
      }
    }
  }

  const sortedNodes = Array.from(nodes).sort();
  const sortedEdges: [string, string][] = Array.from(edges)
    .map((s) => {
      const [a, b] = s.split(" ");
      return [a ?? "", b ?? ""] as [string, string];
    })
    .sort((x, y) => (x[0] === y[0] ? x[1].localeCompare(y[1]) : x[0].localeCompare(y[0])));

  return {
    root: entity,
    hops,
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

/**
 * Entities mentioned via `[[X]]` somewhere but with no memory file defining them.
 * "Defining" = a `.md` file at the memory root whose stem matches the entity name.
 * Also accepts files in conventional subdirs (`entities/`, `live-notes/`, `facts/`)
 * for MemKraft parity.
 */
export function linkOrphans(projectMemory: ProjectMemoryCore): string[] {
  let index = loadForward(projectMemory);
  if (Object.keys(index).length === 0) {
    linkScan(projectMemory);
    index = loadForward(projectMemory);
  }

  const mentioned = new Set<string>();
  for (const targets of Object.values(index)) {
    for (const t of targets) mentioned.add(t);
  }

  const definedStems = new Set<string>();
  const memoryDir = projectMemory.memoryDir;
  for (const abs of iterMemoryFiles(memoryDir)) {
    const name = basename(abs);
    if (name === MEMORY_INDEX_FILE) continue;
    if (name.endsWith(".md")) {
      definedStems.add(name.slice(0, -3));
    }
  }

  const orphans: string[] = [];
  for (const m of mentioned) {
    if (!definedStems.has(m)) {
      orphans.push(m);
    }
  }
  return orphans.sort();
}
