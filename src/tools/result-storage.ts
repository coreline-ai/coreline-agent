/**
 * Tool result storage primitive.
 *
 * Stores large or binary tool outputs under a project/session scoped
 * tool-results directory and returns a small preview message for model context.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getProjectDir } from "../config/paths.js";
import { getProjectId } from "../memory/project-id.js";

export const EMPTY_TOOL_RESULT_MARKER = "[No output]";
export const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 4_000;

export type ToolResultStorageKind = "text" | "binary";
export type ToolResultStorageEncoding = "utf8" | "base64";

export interface StoreToolResultInput {
  /** Tool-use id from the provider/orchestration layer. Used after sanitization in the filename. */
  toolUseId: string;
  /** Human-readable tool name for diagnostics only. */
  toolName: string;
  /** Raw result content. base64 strings require encoding: "base64". */
  content: string | Uint8Array;
  /** Optional MIME type. Used for preview text and default extension selection. */
  mimeType?: string;
  /** Explicit content kind. Defaults to text for strings, binary for bytes/base64. */
  kind?: ToolResultStorageKind;
  /** How to decode string content before writing. Defaults to utf8. */
  encoding?: ToolResultStorageEncoding;
  /** Optional source URI/resource identifier, included in the stable filename hash. */
  sourceUri?: string;
  /** Optional file extension, e.g. ".txt" or "png". Sanitized before use. */
  fileExtension?: string;
}

export interface ToolResultStorageOptions {
  /** Current project cwd. Used to derive the project-scoped storage directory. */
  cwd: string;
  /** Optional test/custom root for ~/.coreline-agent-like project storage. */
  rootDir?: string;
  /** Optional direct base directory. tool-results will be created inside this directory. */
  baseDir?: string;
  /** Optional already-computed project id. */
  projectId?: string;
  /** Optional session id. If present, storage nests under sessions/<sessionId>/tool-results. */
  sessionId?: string;
  /** Preview length for text content. */
  previewChars?: number;
}

export interface StoredToolResult {
  toolUseId: string;
  toolName: string;
  filePath: string;
  fileName: string;
  directory: string;
  bytes: number;
  storedBytes: number;
  isEmpty: boolean;
  isBinary: boolean;
  mimeType?: string;
  preview: string;
  previewMessage: string;
}

interface NormalizedToolResultContent {
  bytes: Uint8Array;
  bytesToWrite: Uint8Array;
  originalText?: string;
  isEmpty: boolean;
  isBinary: boolean;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

export function storeToolResultSync(
  input: StoreToolResultInput,
  options: ToolResultStorageOptions,
): StoredToolResult {
  const normalized = normalizeToolResultContent(input);
  const directory = resolveToolResultsDirectory(options);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const fileName = buildToolResultFileName(input, normalized);
  const filePath = join(directory, fileName);
  writeFileSync(filePath, normalized.bytesToWrite);

  const preview = createToolResultPreview(normalized, {
    previewChars: options.previewChars ?? DEFAULT_TOOL_RESULT_PREVIEW_CHARS,
    mimeType: input.mimeType,
  });

  const stored: StoredToolResult = {
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    filePath,
    fileName,
    directory,
    bytes: normalized.bytes.byteLength,
    storedBytes: normalized.bytesToWrite.byteLength,
    isEmpty: normalized.isEmpty,
    isBinary: normalized.isBinary,
    mimeType: input.mimeType,
    preview,
    previewMessage: "",
  };
  stored.previewMessage = formatStoredToolResultMessage(stored);
  return stored;
}

export async function storeToolResult(
  input: StoreToolResultInput,
  options: ToolResultStorageOptions,
): Promise<StoredToolResult> {
  return storeToolResultSync(input, options);
}

export function resolveToolResultsDirectory(options: ToolResultStorageOptions): string {
  if (options.baseDir) {
    const base = options.sessionId
      ? join(options.baseDir, "sessions", sanitizePathSegment(options.sessionId), "tool-results")
      : join(options.baseDir, "tool-results");
    return base;
  }

  const projectId = options.projectId ?? getProjectId(options.cwd);
  const projectDir = getProjectDir(projectId, options.rootDir);
  if (options.sessionId) {
    return join(projectDir, "sessions", sanitizePathSegment(options.sessionId), "tool-results");
  }
  return join(projectDir, "tool-results");
}

export function formatStoredToolResultMessage(result: StoredToolResult): string {
  const lines = [
    `Tool result saved to: ${result.filePath}`,
    `Bytes: ${result.bytes}`,
  ];

  if (result.mimeType) {
    lines.push(`MIME type: ${result.mimeType}`);
  }

  if (result.isEmpty) {
    lines.push("Result was empty; an empty-result marker was saved.");
  }

  lines.push("Preview:", result.preview);
  return lines.join("\n");
}

export function sanitizePathSegment(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/g, "");

  if (sanitized.length === 0) {
    return "result";
  }
  return sanitized.slice(0, 80);
}

function normalizeToolResultContent(input: StoreToolResultInput): NormalizedToolResultContent {
  const isBase64 = input.encoding === "base64";
  const explicitBinary = input.kind === "binary" || isBase64;
  const bytes = typeof input.content === "string"
    ? new Uint8Array(Buffer.from(input.content, isBase64 ? "base64" : "utf8"))
    : new Uint8Array(input.content);
  const isEmpty = bytes.byteLength === 0;
  const isBinary = explicitBinary || typeof input.content !== "string";

  if (isEmpty) {
    return {
      bytes,
      bytesToWrite: TEXT_ENCODER.encode(`${EMPTY_TOOL_RESULT_MARKER}\n`),
      originalText: "",
      isEmpty: true,
      isBinary,
    };
  }

  return {
    bytes,
    bytesToWrite: bytes,
    originalText: !isBinary && typeof input.content === "string" ? input.content : undefined,
    isEmpty: false,
    isBinary,
  };
}

function buildToolResultFileName(
  input: StoreToolResultInput,
  normalized: NormalizedToolResultContent,
): string {
  const safeToolUseId = sanitizePathSegment(input.toolUseId);
  const hash = createHash("sha256")
    .update(normalized.bytes)
    .update(input.sourceUri ?? "")
    .update(input.toolName)
    .digest("hex")
    .slice(0, 12);
  const extension = normalized.isEmpty
    ? ".empty.txt"
    : resolveFileExtension(input.fileExtension, input.mimeType, normalized.isBinary);
  return basename(`${safeToolUseId}-${hash}${extension}`);
}

function resolveFileExtension(
  explicit: string | undefined,
  mimeType: string | undefined,
  isBinary: boolean,
): string {
  if (explicit?.trim()) {
    const cleaned = explicit.trim().replace(/^\.+/, "").replace(/[^A-Za-z0-9_-]+/g, "");
    return cleaned ? `.${cleaned.slice(0, 16)}` : (isBinary ? ".bin" : ".txt");
  }

  const fromMime = mimeTypeToExtension(mimeType);
  if (fromMime) {
    return fromMime;
  }
  return isBinary ? ".bin" : ".txt";
}

function mimeTypeToExtension(mimeType: string | undefined): string | undefined {
  const type = mimeType?.split(";")[0]?.trim().toLowerCase();
  switch (type) {
    case "text/plain":
    case "text/markdown":
      return ".txt";
    case "application/json":
      return ".json";
    case "application/pdf":
      return ".pdf";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/octet-stream":
      return ".bin";
    default:
      return undefined;
  }
}

function createToolResultPreview(
  normalized: NormalizedToolResultContent,
  options: { previewChars: number; mimeType?: string },
): string {
  if (normalized.isEmpty) {
    return EMPTY_TOOL_RESULT_MARKER;
  }

  if (normalized.isBinary) {
    const mime = options.mimeType ? `, ${options.mimeType}` : "";
    return `[binary data: ${normalized.bytes.byteLength} bytes${mime}]`;
  }

  const text = normalized.originalText ?? TEXT_DECODER.decode(normalized.bytes);
  const limit = Math.max(0, options.previewChars);
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n[preview truncated: showing ${limit} of ${text.length} chars]`;
}
