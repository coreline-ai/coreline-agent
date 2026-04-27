/**
 * FileEditTool — exact string replacement in files.
 * Reference: Claude Code FileEditTool pattern (unique match requirement).
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildTool } from "../types.js";
import type { ToolUseContext, ToolResult, PermissionResult } from "../types.js";
import { formatDiffSummary, generateUnifiedDiff } from "../../agent/diff-preview.js";
import {
  MAX_EDIT_FILE_SIZE,
  applyEditToFile,
  containsNullByte,
  decodeEditableFileBuffer,
  encodeEditableFileContent,
} from "./edit-utils.js";

interface FileEditOutput {
  filePath: string;
  replacements: number;
  originalLength: number;
  newLength: number;
  diff?: string;
  diffSummary?: string;
  errorReason?:
    | "not_found"
    | "not_unique"
    | "read_error"
    | "write_error"
    | "no_op"
    | "too_large"
    | "binary_file"
    | "empty_old_string"
    | "unread"
    | "partial_read"
    | "stale_write";
}

async function atomicWriteEditableFile(filePath: string, data: Buffer, mode: number | undefined): Promise<void> {
  const targetPath = await realpath(filePath).catch(() => filePath);
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.coreline-edit-${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, data, { flag: "wx", mode: mode == null ? 0o600 : mode & 0o7777 });
    if (mode != null) {
      await chmod(tempPath, mode & 0o7777);
    }
    await rename(tempPath, targetPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

function countLines(content: string): number {
  return content.split("\n").length;
}

async function refreshReadFileStateAfterEdit(
  context: ToolUseContext,
  filePath: string,
  content: string,
): Promise<void> {
  if (!context.readFileState) return;

  try {
    const stats = await stat(filePath);
    context.readFileState.set(filePath, {
      filePath,
      content,
      mtimeMs: stats.mtimeMs,
      offset: 0,
      limit: countLines(content),
      isPartialView: false,
    });
  } catch {
    context.readFileState.delete(filePath);
  }
}

export const FileEditTool = buildTool<
  { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
  FileEditOutput
>({
  name: "FileEdit",
  description:
    "Perform exact string replacement in a file. By default, old_string must be unique " +
    "in the file (use replace_all: true to replace all occurrences).",
  maxResultSizeChars: 10_000,

  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to edit"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The replacement text"),
    replace_all: z.boolean().optional().default(false).describe("Replace all occurrences"),
  }),

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  checkPermissions: (_input): PermissionResult => ({ behavior: "ask" }),

  async call(input, context: ToolUseContext): Promise<ToolResult<FileEditOutput>> {
    const filePath = resolve(context.cwd, input.file_path);

    if (input.old_string.length === 0) {
      return {
        data: { filePath, replacements: 0, originalLength: 0, newLength: 0, errorReason: "empty_old_string" },
        isError: true,
      };
    }

    if (input.old_string === input.new_string) {
      return {
        data: { filePath, replacements: 0, originalLength: 0, newLength: 0, errorReason: "no_op" },
        isError: true,
      };
    }

    let content: string;
    let originalLength = 0;
    let encoding: ReturnType<typeof decodeEditableFileBuffer>["encoding"];
    let originalMode: number | undefined;

    try {
      const stats = await stat(filePath);
      if (stats.size > MAX_EDIT_FILE_SIZE) {
        return {
          data: { filePath, replacements: 0, originalLength: 0, newLength: 0, errorReason: "too_large" },
          isError: true,
        };
      }

      const decoded = decodeEditableFileBuffer(await readFile(filePath));
      content = decoded.content;
      encoding = decoded.encoding;
      originalLength = content.length;
      originalMode = stats.mode;

      if (containsNullByte(content)) {
        return {
          data: { filePath, replacements: 0, originalLength, newLength: originalLength, errorReason: "binary_file" },
          isError: true,
        };
      }

      const readState = context.readFileState?.get(filePath);
      if (context.readFileState && !readState) {
        return {
          data: { filePath, replacements: 0, originalLength, newLength: originalLength, errorReason: "unread" },
          isError: true,
        };
      }

      if (readState?.isPartialView) {
        return {
          data: { filePath, replacements: 0, originalLength, newLength: originalLength, errorReason: "partial_read" },
          isError: true,
        };
      }

      if (readState && readState.content !== content) {
        return {
          data: { filePath, replacements: 0, originalLength, newLength: originalLength, errorReason: "stale_write" },
          isError: true,
        };
      }

      if (readState && readState.mtimeMs !== stats.mtimeMs) {
        context.readFileState?.set(filePath, { ...readState, mtimeMs: stats.mtimeMs });
      }
    } catch (err) {
      return {
        data: { filePath, replacements: 0, originalLength: 0, newLength: 0, errorReason: "read_error" },
        isError: true,
      };
    }

    const edit = applyEditToFile(content, input.old_string, input.new_string, input.replace_all === true);
    if (!edit.ok) {
      return {
        data: {
          filePath,
          replacements: 0,
          originalLength,
          newLength: originalLength,
          errorReason: edit.reason,
        },
        isError: true,
      };
    }

    try {
      const newContent = edit.content;

      // Capture the pre-edit state once per session before mutating the file.
      await context.backupStore?.backup(filePath);

      await atomicWriteEditableFile(filePath, encodeEditableFileContent(newContent, encoding), originalMode);
      context.toolCache?.invalidatePath(filePath);
      await refreshReadFileStateAfterEdit(context, filePath, newContent);
      const diffPreview = generateUnifiedDiff(content, newContent, filePath);
      const diffSummary = formatDiffSummary(diffPreview).text;

      return {
        data: {
          filePath,
          replacements: edit.replacements,
          originalLength,
          newLength: newContent.length,
          diff: diffPreview.diff || undefined,
          diffSummary,
        },
      };
    } catch (err) {
      return {
        data: { filePath, replacements: 0, originalLength, newLength: originalLength, errorReason: "write_error" },
        isError: true,
      };
    }
  },

  formatResult(output: FileEditOutput, _toolUseId: string): string {
    if (output.errorReason === "not_found") {
      return `Error: old_string not found in ${output.filePath}`;
    }
    if (output.errorReason === "not_unique") {
      return `Error: old_string matched multiple times in ${output.filePath}. Use replace_all: true to replace all.`;
    }
    if (output.errorReason === "read_error") {
      return `Error: could not read ${output.filePath}`;
    }
    if (output.errorReason === "write_error") {
      return `Error: could not write ${output.filePath}`;
    }
    if (output.errorReason === "no_op") {
      return `Error: old_string and new_string are identical for ${output.filePath}`;
    }
    if (output.errorReason === "too_large") {
      return `Error: file too large to edit in ${output.filePath}`;
    }
    if (output.errorReason === "binary_file") {
      return `Error: binary or null-byte file cannot be edited as text: ${output.filePath}`;
    }
    if (output.errorReason === "empty_old_string") {
      return `Error: old_string must not be empty for ${output.filePath}`;
    }
    if (output.errorReason === "unread") {
      return `Error: read ${output.filePath} with FileRead before editing it`;
    }
    if (output.errorReason === "partial_read") {
      return `Error: ${output.filePath} was only partially read. Run a full FileRead before editing it.`;
    }
    if (output.errorReason === "stale_write") {
      return `Error: ${output.filePath} changed since it was last read. Re-read the file before editing.`;
    }
    if (output.replacements === 0) {
      return `Error: no replacements made in ${output.filePath}`;
    }
    const summary = output.diffSummary ? `\nDiff: ${output.diffSummary}` : "";
    const diff = output.diff ? `\n\n\`\`\`diff\n${output.diff}\n\`\`\`` : "";
    return `Edited ${output.filePath}: ${output.replacements} replacement(s) (${output.originalLength} → ${output.newLength} chars)${summary}${diff}`;
  },
});
