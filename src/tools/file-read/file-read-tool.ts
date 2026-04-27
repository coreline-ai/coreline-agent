/**
 * FileReadTool — read file contents with line numbers.
 * Supports offset/limit for partial reads. Detects binary/image files.
 */

import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { buildTool } from "../types.js";
import type { ReadFileStateEntry, ToolUseContext, ToolResult, PermissionResult } from "../types.js";
import { checkFileReadPathSafety } from "./read-safety.js";
import { decodeEditableFileBuffer } from "../file-edit/edit-utils.js";

const DEFAULT_LIMIT = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const BINARY_EXTENSIONS = new Set([".exe", ".dll", ".so", ".dylib", ".zip", ".tar", ".gz", ".pdf"]);

interface FileReadOutput {
  content: string;
  filePath: string;
  totalLines: number;
  displayedLines: number;
  isImage: boolean;
  isBinary: boolean;
  /** Base64-encoded image data (only for image files) */
  base64?: string;
}

const READ_STATE_METADATA: unique symbol = Symbol("coreline.fileReadState");

type FileReadOutputWithState = FileReadOutput & {
  [READ_STATE_METADATA]?: ReadFileStateEntry;
};

function attachReadState(output: FileReadOutput, entry: ReadFileStateEntry): FileReadOutput {
  Object.defineProperty(output, READ_STATE_METADATA, {
    value: { ...entry },
    enumerable: false,
    configurable: false,
  });
  return output;
}

function recordReadStateFromResult(
  context: ToolUseContext,
  result: ToolResult<FileReadOutput>,
): void {
  if (result.isError || !context.readFileState) return;
  const entry = (result.data as FileReadOutputWithState)[READ_STATE_METADATA];
  if (!entry) return;
  context.readFileState.set(entry.filePath, { ...entry });
}

export const FileReadTool = buildTool<
  { file_path: string; offset?: number; limit?: number },
  FileReadOutput
>({
  name: "FileRead",
  description:
    "Read a file from the filesystem. Returns contents with line numbers. " +
    "Use offset and limit to read specific sections of large files.",
  maxResultSizeChars: 200_000,

  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to read"),
    offset: z.number().int().min(0).optional().describe("Line number to start from (0-based)"),
    limit: z.number().int().min(1).optional().describe("Number of lines to read"),
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  checkPermissions: (): PermissionResult => ({ behavior: "allow" }),

  async call(input, context: ToolUseContext): Promise<ToolResult<FileReadOutput>> {
    const filePath = resolve(context.cwd, input.file_path);
    const ext = extname(filePath).toLowerCase();

    const pathSafety = checkFileReadPathSafety(filePath);
    if (pathSafety.blocked) {
      return {
        data: {
          content: `Error: ${pathSafety.reason}`,
          filePath,
          totalLines: 0,
          displayedLines: 0,
          isImage: false,
          isBinary: false,
        },
        isError: true,
      };
    }

    const executeRead = async (): Promise<ToolResult<FileReadOutput>> => {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? DEFAULT_LIMIT;

      // Binary detection
      if (BINARY_EXTENSIONS.has(ext)) {
        try {
          const stats = await stat(filePath);
          const content = `[Binary file: ${filePath}]`;
          return {
            data: attachReadState(
              {
                content,
                filePath,
                totalLines: 0,
                displayedLines: 0,
                isImage: false,
                isBinary: true,
              },
              {
                filePath,
                content,
                mtimeMs: stats.mtimeMs,
                offset,
                limit,
                isPartialView: true,
              },
            ),
          };
        } catch (err) {
          return {
            data: {
              content: `Error: ${(err as Error).message}`,
              filePath,
              totalLines: 0,
              displayedLines: 0,
              isImage: false,
              isBinary: true,
            },
            isError: true,
          };
        }
      }

      // Image detection
      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const [stats, buffer] = await Promise.all([stat(filePath), readFile(filePath)]);
          const base64 = buffer.toString("base64");
          const content = `[Image: ${filePath}] (${buffer.length} bytes)`;
          return {
            data: attachReadState(
              {
                content,
                filePath,
                totalLines: 0,
                displayedLines: 0,
                isImage: true,
                isBinary: false,
                base64,
              },
              {
                filePath,
                content,
                mtimeMs: stats.mtimeMs,
                offset,
                limit,
                isPartialView: true,
              },
            ),
          };
        } catch (err) {
          return {
            data: {
              content: `Error reading image: ${(err as Error).message}`,
              filePath,
              totalLines: 0,
              displayedLines: 0,
              isImage: true,
              isBinary: false,
            },
            isError: true,
          };
        }
      }

      // Text file
      try {
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          return {
            data: {
              content: `[File too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB. Use offset/limit to read sections.]`,
              filePath,
              totalLines: 0,
              displayedLines: 0,
              isImage: false,
              isBinary: false,
            },
            isError: true,
          };
        }

        const raw = decodeEditableFileBuffer(await readFile(filePath)).content;
        const allLines = raw.split("\n");
        const totalLines = allLines.length;

        const selectedLines = allLines.slice(offset, offset + limit);
        const isPartialView = offset > 0 || offset + selectedLines.length < totalLines;

        // Format with line numbers (cat -n style)
        const numbered = selectedLines.map(
          (line, i) => `${String(offset + i + 1).padStart(6, " ")}\t${line}`,
        );

        return {
          data: attachReadState(
            {
              content: numbered.join("\n"),
              filePath,
              totalLines,
              displayedLines: selectedLines.length,
              isImage: false,
              isBinary: false,
            },
            {
              filePath,
              content: raw,
              mtimeMs: stats.mtimeMs,
              offset,
              limit,
              isPartialView,
            },
          ),
        };
      } catch (err) {
        return {
          data: {
            content: `Error: ${(err as Error).message}`,
            filePath,
            totalLines: 0,
            displayedLines: 0,
            isImage: false,
            isBinary: false,
          },
          isError: true,
        };
      }
    };

    if (context.toolCache) {
      const result = await context.toolCache.getOrSet(
        {
          cwd: context.cwd,
          toolName: "FileRead",
          input,
          paths: [input.file_path],
        },
        executeRead,
      );
      recordReadStateFromResult(context, result);
      return result;
    }

    const result = await executeRead();
    recordReadStateFromResult(context, result);
    return result;
  },

  formatResult(output: FileReadOutput, _toolUseId: string): string {
    if (output.isImage || output.isBinary) return output.content;
    let result = output.content;
    if (output.displayedLines < output.totalLines) {
      result += `\n\n[Showing ${output.displayedLines} of ${output.totalLines} lines]`;
    }
    return result;
  },
});
