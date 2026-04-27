import fg from "fast-glob";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AtFileAttachment,
  AtFileExpansionOptions,
  AtFileExpansionResult,
  AtFileIssue,
  AtFileToken,
} from "./types.js";

const DEFAULT_MAX_BYTES_PER_FILE = 64 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8");
const TRAILING_PUNCTUATION = /[)\]}>,;:!?"'`]+$/;
const LEADING_PUNCTUATION = /^[([\{<'"`]+/;

function normalizeText(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function normalizeAttachmentChunk(chunk: string): string | null {
  let value = chunk.trim();
  value = value.replace(LEADING_PUNCTUATION, "");
  if (!value.startsWith("@")) return null;

  value = value.slice(1);
  value = value.replace(LEADING_PUNCTUATION, "");
  value = value.replace(TRAILING_PUNCTUATION, "");

  while (value.endsWith(".") && (value.includes("/") || value.includes("\\") || value.includes("."))) {
    value = value.slice(0, -1);
  }

  value = value.trim();
  return value.length > 0 ? value : null;
}

function isGlobPattern(pathname: string): boolean {
  return /[*?[\]]/.test(pathname);
}

function toAbsolutePath(pathname: string, cwd: string): string {
  return isAbsolute(pathname) ? pathname : resolve(cwd, pathname);
}

function toDisplayPath(pathname: string, cwd: string): string {
  const rel = relative(canonicalDirectory(cwd), pathname);
  if (!rel || rel === "") return ".";
  return rel.startsWith("..") ? pathname : rel;
}

function canonicalPath(pathname: string): string {
  try {
    return realpathSync(pathname);
  } catch {
    return pathname;
  }
}

function canonicalDirectory(pathname: string): string {
  try {
    return realpathSync(pathname);
  } catch {
    return pathname;
  }
}

function isLikelyBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  const sampleSize = Math.min(bytes.length, 8192);
  let suspicious = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }

  return suspicious / sampleSize > 0.3;
}

function removeTokenSpans(text: string, tokens: AtFileToken[]): string {
  if (tokens.length === 0) return normalizeText(text);

  const spans = [...tokens].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let result = "";

  for (const span of spans) {
    if (span.start < cursor) continue;
    result += text.slice(cursor, span.start);
    cursor = span.end;
  }

  result += text.slice(cursor);
  return normalizeText(result);
}

function issue(sourceToken: string, rawPath: string, kind: AtFileIssue["kind"], message: string, resolvedPath?: string): AtFileIssue {
  return { sourceToken, rawPath, kind, message, resolvedPath };
}

function resolveGlobMatches(rawPath: string, cwd: string): string[] {
  if (isAbsolute(rawPath)) {
    return fg.sync(rawPath, {
      absolute: true,
      onlyFiles: true,
      dot: true,
      unique: true,
      followSymbolicLinks: true,
    });
  }

  return fg.sync(rawPath, {
    cwd,
    absolute: true,
    onlyFiles: true,
    dot: true,
    unique: true,
    followSymbolicLinks: true,
  });
}

function resolveLiteralPath(rawPath: string, cwd: string): string {
  return toAbsolutePath(rawPath, cwd);
}

function readAttachmentFile(
  sourceToken: string,
  rawPath: string,
  filePath: string,
  cwd: string,
  maxBytesPerFile: number,
): { attachment?: AtFileAttachment; issue?: AtFileIssue } {
  if (!existsSync(filePath)) {
    return { issue: issue(sourceToken, rawPath, "missing", `File not found: ${sourceToken}`) };
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { issue: issue(sourceToken, rawPath, "not_a_file", `Path is not a file: ${sourceToken}`, filePath) };
  }

  if (stat.size > maxBytesPerFile) {
    return {
      issue: issue(
        sourceToken,
        rawPath,
        "too_large",
        `File exceeds ${maxBytesPerFile} bytes: ${sourceToken} (${stat.size} bytes)`,
        filePath,
      ),
    };
  }

  const bytes = readFileSync(filePath);
  if (isLikelyBinary(bytes)) {
    return { issue: issue(sourceToken, rawPath, "binary", `Binary file skipped: ${sourceToken}`, filePath) };
  }

  const resolvedPath = canonicalPath(filePath);
  const attachment: AtFileAttachment = {
    sourceToken,
    rawPath,
    resolvedPath,
    displayPath: toDisplayPath(resolvedPath, cwd),
    byteLength: bytes.byteLength,
    content: TEXT_DECODER.decode(bytes),
  };

  return { attachment };
}

export function parseAtFileTokens(prompt: string): AtFileToken[] {
  const tokens: AtFileToken[] = [];

  for (const match of prompt.matchAll(/\S+/g)) {
    const chunk = match[0];
    const start = match.index ?? 0;
    const rawPath = normalizeAttachmentChunk(chunk);
    if (!rawPath) continue;

    tokens.push({
      token: chunk,
      rawPath,
      start,
      end: start + chunk.length,
      isGlob: isGlobPattern(rawPath),
    });
  }

  return tokens;
}

export function expandAtFilePrompt(
  prompt: string,
  options: AtFileExpansionOptions = {},
): AtFileExpansionResult {
  const cwd = options.cwd ?? process.cwd();
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const tokens = parseAtFileTokens(prompt);
  const text = removeTokenSpans(prompt, tokens);

  if (tokens.length === 0) {
    return { text, attachments: [], issues: [], tokens };
  }

  const attachments: AtFileAttachment[] = [];
  const issues: AtFileIssue[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const paths = token.isGlob
      ? resolveGlobMatches(token.rawPath, cwd)
      : [resolveLiteralPath(token.rawPath, cwd)];

    if (paths.length === 0) {
      issues.push(
        issue(
          token.token,
          token.rawPath,
          token.isGlob ? "glob_no_matches" : "missing",
          token.isGlob ? `No files matched glob: ${token.token}` : `File not found: ${token.token}`,
        ),
      );
      continue;
    }

    for (const path of paths) {
      const canonical = canonicalPath(path);
      if (seen.has(canonical)) {
        issues.push(issue(token.token, token.rawPath, "duplicate", `Skipped duplicate attachment: ${token.token}`, canonical));
        continue;
      }

      const result = readAttachmentFile(token.token, token.rawPath, path, cwd, maxBytesPerFile);
      if (result.issue) {
        issues.push(result.issue);
        continue;
      }

      seen.add(canonical);
      attachments.push(result.attachment!);
    }
  }

  return { text, attachments, issues, tokens };
}
