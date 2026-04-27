import { z } from "zod";
import { basename } from "node:path";
import { buildTool } from "../types.js";
import type { ToolResult } from "../types.js";

interface MemoryReadListOutput {
  mode: "list";
  entries: Array<{ name: string; type: string; description: string; file: string; preview?: string }>;
}

interface MemoryReadEntryOutput {
  mode: "entry";
  entry: {
    name: string;
    type: string;
    description: string;
    body: string;
    filePath: string;
  };
}

type MemoryReadOutput = MemoryReadListOutput | MemoryReadEntryOutput | { mode: "error"; message: string };

function formatListEntry(entry: MemoryReadListOutput["entries"][number], index: number): string {
  return [
    `${index + 1}. name: ${entry.name}`,
    `   type: ${entry.type}`,
    `   description: ${entry.description}`,
    `   file: ${entry.file}`,
    `   preview: ${entry.preview || "(no preview)"}`,
  ].join("\n");
}

function formatList(entries: MemoryReadListOutput["entries"]): string {
  if (entries.length === 0) {
    return [
      "MEMORY_READ_RESULT",
      "mode: list",
      "summary: no memory entries found",
      "count: 0",
      "",
      "No memory entries found.",
      "NEXT_STEP: Use MemoryWrite to save durable project context.",
    ].join("\n");
  }

  return [
    "MEMORY_READ_RESULT",
    "mode: list",
    `summary: ${entries.length} memory entr${entries.length === 1 ? "y" : "ies"} available`,
    `count: ${entries.length}`,
    "",
    "ENTRIES_START",
    ...entries.map((entry, index) => formatListEntry(entry, index)),
    "ENTRIES_END",
    "",
    'NEXT_STEP: Call MemoryRead with { "name": "<entry>" } to load one entry.',
  ].join("\n");
}

function formatEntry(entry: MemoryReadEntryOutput["entry"]): string {
  return [
    "MEMORY_READ_RESULT",
    "mode: entry",
    "summary: memory entry loaded",
    "answer_hint: if the user's question matches this entry, answer from ENTRY_BODY_START to ENTRY_BODY_END directly",
    `name: ${entry.name}`,
    `type: ${entry.type}`,
    `description: ${entry.description}`,
    `file: ${basename(entry.filePath)}`,
    "",
    "ENTRY_BODY_START",
    entry.body || "[empty body]",
    "ENTRY_BODY_END",
  ].join("\n");
}

export const MemoryReadTool = buildTool<{ name?: string; scope?: "project" | "global" }, MemoryReadOutput>({
  name: "MemoryRead",
  description:
    "Read memory entries. scope=project (default) reads project memory, scope=global reads user-wide preferences. " +
    "With no name, returns the index. With a name, returns the full entry.",
  maxResultSizeChars: 20_000,

  inputSchema: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional().describe("Optional memory entry name"),
    scope: z.enum(["project", "global"]).optional().describe("Memory scope: project (default) or global"),
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, context): Promise<ToolResult<MemoryReadOutput>> {
    const scope = input.scope ?? "project";

    // Global scope
    if (scope === "global") {
      const globalMemory = context.globalMemory;
      if (!globalMemory) {
        return {
          data: { mode: "error", message: "Global user memory is not available in this session." },
          isError: true,
        };
      }

      if (!input.name) {
        const globalEntries = globalMemory.listEntries().map((e) => ({
          name: e.name,
          type: e.type,
          description: e.description,
          file: basename(e.filePath),
          preview: e.body.trim().replace(/\s+/g, " ").slice(0, 120) || undefined,
        }));
        return { data: { mode: "list", entries: globalEntries } };
      }

      const globalEntry = globalMemory.readEntry(input.name);
      if (!globalEntry) {
        return { data: { mode: "error", message: `Global memory entry not found: ${input.name}` }, isError: true };
      }
      return {
        data: {
          mode: "entry",
          entry: {
            name: globalEntry.name,
            type: globalEntry.type,
            description: globalEntry.description,
            body: globalEntry.body,
            filePath: globalEntry.filePath,
          },
        },
      };
    }

    // Project scope (default)
    const projectMemory = context.projectMemory;
    if (!projectMemory) {
      return {
        data: { mode: "error", message: "Project memory is not available in this session." },
        isError: true,
      };
    }

    if (!input.name) {
      const entries = projectMemory.listEntries().map((entry) => {
        const fullEntry = projectMemory.readEntry(entry.name);
        const preview = fullEntry?.body
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 120);

        return {
          ...entry,
          preview: preview || undefined,
        };
      });

      return {
        data: {
          mode: "list",
          entries,
        },
      };
    }

    const entry = projectMemory.readEntry(input.name);
    if (!entry) {
      return {
        data: { mode: "error", message: `Memory entry not found: ${input.name}` },
        isError: true,
      };
    }

    return {
      data: {
        mode: "entry",
        entry,
      },
    };
  },

  formatResult(output): string {
    if (output.mode === "error") {
      return ["MEMORY_READ_RESULT", "mode: error", `message: ${output.message}`].join("\n");
    }

    if (output.mode === "list") {
      return formatList(output.entries);
    }

    return formatEntry(output.entry);
  },
});
