import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  ContextCandidate,
  ContextCandidateReason,
  ContextCollectionRequest,
  ContextCollectionResult,
  ContextExcludedCandidate,
} from "./intelligence-types.js";
import { buildImportGraph, DEFAULT_IMPORT_GRAPH_EXTENSIONS } from "../utils/import-graph.js";

const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_FILE_SIZE_BYTES = 200 * 1024;
const DEFAULT_EXCLUDE_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache"]);
const SECRET_PATH_RE = /(^|\/)(\.env(?:\..*)?|id_rsa|id_dsa|credentials?|secrets?|.*\.(?:pem|key|p12|pfx))$/i;
const PATH_HINT_RE = /(?:^|[\s`'"(])((?:\.?\.?\/)?(?:[\w.-]+\/)+[\w.@-]+\.[a-zA-Z0-9]+)(?=$|[\s`'"),:;])/g;
const SYMBOL_HINT_RE = /`([A-Za-z_$][\w$]{2,})`|\b([A-Z][A-Za-z0-9_$]{2,}|[a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*)\b/g;

function toProjectPath(filePath: string, cwd: string): string {
  const absolute = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  return normalize(relative(cwd, absolute)).replace(/\\/g, "/");
}

function safeResolve(cwd: string, projectPath: string): string | undefined {
  const absolute = resolve(cwd, projectPath);
  const relativePath = relative(cwd, absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }
  return absolute;
}

function isBinaryFile(filePath: string): boolean {
  const buffer = readFileSync(filePath);
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function exclusionForPath(
  absolutePath: string,
  projectPath: string,
  maxFileSizeBytes: number,
  includeExtensions: string[],
): ContextExcludedCandidate | undefined {
  const extension = extname(projectPath);
  if (!includeExtensions.includes(extension)) {
    return { path: projectPath, reason: "unsupported-extension", detail: extension || "no extension" };
  }

  if (SECRET_PATH_RE.test(projectPath) || SECRET_PATH_RE.test(basename(projectPath))) {
    return { path: projectPath, reason: "secret-like" };
  }

  const sizeBytes = statSync(absolutePath).size;
  if (sizeBytes > maxFileSizeBytes) {
    return { path: projectPath, reason: "oversized", detail: `${sizeBytes} > ${maxFileSizeBytes}` };
  }

  if (isBinaryFile(absolutePath)) {
    return { path: projectPath, reason: "binary" };
  }

  return undefined;
}

function walkFiles(cwd: string, excludeDirs: Set<string>, limit = 2_000): string[] {
  const files: string[] = [];
  const stack = [cwd];

  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (files.length >= limit) {
        break;
      }
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(toProjectPath(fullPath, cwd));
      }
    }
  }

  return files.sort();
}

export function extractPathHints(prompt: string): string[] {
  const hints = new Set<string>();
  for (const match of prompt.matchAll(PATH_HINT_RE)) {
    const value = match[1]?.replace(/^\.\//, "");
    if (value) {
      hints.add(value);
    }
  }
  return [...hints].sort();
}

export function extractSymbolHints(prompt: string): string[] {
  const symbols = new Set<string>();
  for (const match of prompt.matchAll(SYMBOL_HINT_RE)) {
    const value = match[1] ?? match[2];
    if (!value) {
      continue;
    }
    if (["The", "This", "That", "Please", "TODO", "HTTP", "JSON"].includes(value)) {
      continue;
    }
    symbols.add(value);
  }
  return [...symbols].sort();
}

function addReason(candidate: ContextCandidate, reason: ContextCandidateReason, score: number): void {
  if (!candidate.reasons.includes(reason)) {
    candidate.reasons.push(reason);
  }
  candidate.score += score;
}

function createCandidate(path: string, sizeBytes: number): ContextCandidate {
  return { path, score: 0, reasons: [], sizeBytes };
}

export function collectContextCandidates(request: ContextCollectionRequest): ContextCollectionResult {
  const cwd = resolve(request.cwd);
  const maxCandidates = request.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxFileSizeBytes = request.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const includeExtensions = request.includeExtensions ?? DEFAULT_IMPORT_GRAPH_EXTENSIONS;
  const excludeDirs = new Set([...(request.excludeDirs ?? []), ...DEFAULT_EXCLUDE_DIRS]);
  const mentionedFiles = [...new Set([...(request.mentionedFiles ?? []), ...extractPathHints(request.prompt)])];
  const mentionedSymbols = [...new Set([...(request.mentionedSymbols ?? []), ...extractSymbolHints(request.prompt)])];
  const excluded: ContextExcludedCandidate[] = [];
  const allProjectFiles = walkFiles(cwd, excludeDirs).filter((path) => includeExtensions.includes(extname(path)));
  const graph = buildImportGraph(allProjectFiles, { cwd, extensions: includeExtensions });
  const candidates = new Map<string, ContextCandidate>();

  function ensureCandidate(projectPath: string): ContextCandidate | undefined {
    const absolutePath = safeResolve(cwd, projectPath);
    if (!absolutePath || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      excluded.push({ path: projectPath, reason: "not-found" });
      return undefined;
    }

    const normalized = toProjectPath(absolutePath, cwd);
    const exclusion = exclusionForPath(absolutePath, normalized, maxFileSizeBytes, includeExtensions);
    if (exclusion) {
      excluded.push(exclusion);
      return undefined;
    }

    const existing = candidates.get(normalized);
    if (existing) {
      return existing;
    }

    const node = graph.nodes.get(normalized);
    const candidate = createCandidate(normalized, statSync(absolutePath).size);
    if (node) {
      candidate.imports = node.imports;
      candidate.importedBy = node.importedBy;
    }
    candidates.set(normalized, candidate);
    return candidate;
  }

  for (const mentionedFile of mentionedFiles) {
    const normalizedMention = mentionedFile.replace(/^\.\//, "");
    const direct = ensureCandidate(normalizedMention);
    if (direct) {
      addReason(direct, "mentioned-file", 100);
      const node = graph.nodes.get(direct.path);
      for (const imported of node?.imports ?? []) {
        const importedCandidate = ensureCandidate(imported);
        if (importedCandidate) {
          addReason(importedCandidate, "imports-mentioned-file", 30);
        }
      }
      for (const importer of node?.importedBy ?? []) {
        const importerCandidate = ensureCandidate(importer);
        if (importerCandidate) {
          addReason(importerCandidate, "imported-by-mentioned-file", 25);
        }
      }
      continue;
    }

    for (const file of allProjectFiles) {
      if (file.includes(normalizedMention)) {
        const candidate = ensureCandidate(file);
        if (candidate) {
          addReason(candidate, "path-fragment", 60);
        }
      }
    }
  }

  const symbolHintsLower = mentionedSymbols.map((symbol) => symbol.toLowerCase());
  if (symbolHintsLower.length > 0) {
    for (const file of allProjectFiles) {
      const absolutePath = safeResolve(cwd, file);
      if (!absolutePath) {
        continue;
      }
      const exclusion = exclusionForPath(absolutePath, file, maxFileSizeBytes, includeExtensions);
      if (exclusion) {
        if (!excluded.some((item) => item.path === exclusion.path && item.reason === exclusion.reason)) {
          excluded.push(exclusion);
        }
        continue;
      }
      const source = readFileSync(absolutePath, "utf-8").toLowerCase();
      const matchedSymbols = mentionedSymbols.filter((symbol, index) => source.includes(symbolHintsLower[index]!));
      if (matchedSymbols.length === 0) {
        continue;
      }
      const candidate = ensureCandidate(file);
      if (candidate) {
        candidate.matchedSymbols = [...new Set([...(candidate.matchedSymbols ?? []), ...matchedSymbols])].sort();
        addReason(candidate, "symbol-match", 10 * matchedSymbols.length);
      }
    }
  }

  return {
    cwd,
    candidates: [...candidates.values()]
      .filter((candidate) => candidate.reasons.length > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxCandidates),
    excluded: [...new Map(excluded.map((item) => [`${item.path}:${item.reason}`, item])).values()].sort((a, b) => a.path.localeCompare(b.path)),
    mentionedFiles: mentionedFiles.sort(),
    mentionedSymbols: mentionedSymbols.sort(),
  };
}
