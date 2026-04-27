/**
 * IngestDocument — split a document into overlapping chunks and store them
 * as project-memory entries (Wave 7 Phase 4 / D16).
 */

import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTool } from "../types.js";
import type { PermissionResult, ToolResult, ToolUseContext } from "../types.js";
import { trackDocument } from "../../memory/chunking.js";
import type { ChunkingResult } from "../../memory/chunking-types.js";
import { checkFileReadPathSafety } from "../file-read/read-safety.js";

const InputSchema = z.object({
  docId: z.string().min(1).describe("Document identifier (parent entity name)"),
  contentPath: z.string().optional().describe("Absolute or cwd-relative file path to ingest"),
  contentText: z.string().optional().describe("Raw text body (alternative to contentPath)"),
  chunkSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Words per chunk (default 500)"),
  chunkOverlap: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Overlap in words between consecutive chunks (default 50)"),
  source: z.string().optional().describe("Source/provenance tag for the parent entry"),
});

type IngestDocumentInput = z.infer<typeof InputSchema>;

function errorResult(docId: string, error: string): ToolResult<ChunkingResult> {
  return {
    data: {
      docId,
      chunksCreated: 0,
      parentTracked: false,
      failures: [{ chunkIdx: -1, error }],
    },
    isError: true,
  };
}

export const IngestDocumentTool = buildTool<IngestDocumentInput, ChunkingResult>({
  name: "IngestDocument",
  description:
    "Split a document into overlapping word-level chunks and store them as project memory " +
    "entries for precise retrieval. Use contentPath to read a file, or contentText for inline text.",
  maxResultSizeChars: 5_000,

  inputSchema: InputSchema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  checkPermissions: (input, context: ToolUseContext): PermissionResult => {
    if (input.contentPath) {
      const abs = resolve(context.cwd, input.contentPath);
      const safety = checkFileReadPathSafety(abs);
      if (safety.blocked) {
        return { behavior: "deny", reason: safety.reason };
      }
      if (!abs.startsWith(context.cwd)) {
        return {
          behavior: "deny",
          reason: `contentPath outside cwd: ${input.contentPath}`,
        };
      }
    }
    return { behavior: "allow", reason: "Document ingest into project memory" };
  },

  async call(input, context: ToolUseContext): Promise<ToolResult<ChunkingResult>> {
    const projectMemory = context.projectMemory;
    if (!projectMemory) {
      return errorResult(input.docId, "Project memory is not available in this session.");
    }

    let content: string;
    if (typeof input.contentText === "string" && input.contentText.length > 0) {
      content = input.contentText;
    } else if (input.contentPath) {
      const abs = resolve(context.cwd, input.contentPath);
      try {
        content = readFileSync(abs, "utf-8");
      } catch (err) {
        return errorResult(
          input.docId,
          `Failed to read contentPath: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      return errorResult(input.docId, "Either contentPath or contentText must be provided.");
    }

    try {
      const result = trackDocument(projectMemory, input.docId, content, {
        chunkSize: input.chunkSize,
        chunkOverlap: input.chunkOverlap,
        source: input.source,
      });
      return { data: result, isError: result.failures.length > 0 };
    } catch (err) {
      return errorResult(
        input.docId,
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  formatResult(out: ChunkingResult): string {
    const lines: string[] = [
      "INGEST_DOCUMENT_RESULT",
      `doc_id: ${out.docId}`,
      `chunks_created: ${out.chunksCreated}`,
      `parent_tracked: ${out.parentTracked}`,
      `failures: ${out.failures.length}`,
    ];
    if (out.failures.length > 0) {
      lines.push("FAILURES");
      for (const f of out.failures.slice(0, 5)) {
        lines.push(`- chunk ${f.chunkIdx}: ${f.error}`);
      }
    }
    return lines.join("\n");
  },
});
