/**
 * FileWriteTool — create or overwrite a file.
 * Auto-creates parent directories if needed.
 */

import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { buildTool } from "../types.js";
import type { ToolUseContext, ToolResult, PermissionResult } from "../types.js";

interface FileWriteOutput {
  filePath: string;
  bytesWritten: number;
}

export const FileWriteTool = buildTool<
  { file_path: string; content: string },
  FileWriteOutput
>({
  name: "FileWrite",
  description:
    "Write content to a file. Creates the file if it doesn't exist, " +
    "overwrites if it does. Auto-creates parent directories.",
  maxResultSizeChars: 1_000,

  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to write"),
    content: z.string().describe("Content to write to the file"),
  }),

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  checkPermissions: (_input): PermissionResult => ({ behavior: "ask" }),

  async call(input, context: ToolUseContext): Promise<ToolResult<FileWriteOutput>> {
    const filePath = resolve(context.cwd, input.file_path);

    try {
      // Capture the pre-write state once per session so /undo can restore it.
      await context.backupStore?.backup(filePath);

      // Create parent directories
      await mkdir(dirname(filePath), { recursive: true });

      // Write file
      await writeFile(filePath, input.content, "utf-8");
      context.toolCache?.invalidatePath(filePath);
      context.readFileState?.delete(filePath);

      return {
        data: {
          filePath,
          bytesWritten: Buffer.byteLength(input.content, "utf-8"),
        },
      };
    } catch (err) {
      return {
        data: { filePath, bytesWritten: 0 },
        isError: true,
      };
    }
  },

  formatResult(output: FileWriteOutput, _toolUseId: string): string {
    return `File written: ${output.filePath} (${output.bytesWritten} bytes)`;
  },
});
