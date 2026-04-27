import { z } from "zod";
import { buildTool } from "../types.js";
import type { ToolResult } from "../types.js";
import { detectSensitiveMemoryContent } from "../../memory/safety.js";

interface MemoryWriteOutput {
  name: string;
  filePath: string;
  isNew: boolean;
  scope: "project" | "global";
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MAX_BODY_CHARS = 5_000;

export const MemoryWriteTool = buildTool<
  {
    name: string;
    type: "user" | "feedback" | "project" | "reference" | "preference" | "workflow" | "environment";
    description: string;
    body: string;
    scope?: "project" | "global";
  },
  MemoryWriteOutput | { message: string }
>({
  name: "MemoryWrite",
  description:
    "Write or update a memory entry. scope=project (default) stores project-scoped data, " +
    "scope=global stores user-wide preferences that persist across projects.",
  maxResultSizeChars: 2_000,

  inputSchema: z.object({
    name: z.string().regex(NAME_PATTERN).describe("Stable memory entry name, e.g. user_profile"),
    type: z
      .enum(["user", "feedback", "project", "reference", "preference", "workflow", "environment"])
      .describe("Memory entry type"),
    description: z.string().min(1).max(200).describe("Short summary shown in the memory index"),
    body: z.string().min(1).max(MAX_BODY_CHARS).describe("Memory body in markdown/plain text"),
    scope: z.enum(["project", "global"]).optional().describe("Memory scope: project (default) or global"),
  }),

  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async call(input, context): Promise<ToolResult<MemoryWriteOutput | { message: string }>> {
    const scope = input.scope ?? "project";

    // Sensitive content guard (both scopes)
    const sensitiveLabel = detectSensitiveMemoryContent({
      name: input.name,
      description: input.description,
      body: input.body,
    });
    if (sensitiveLabel) {
      return {
        data: { message: `Refused to store sensitive content (${sensitiveLabel}). Do not save API keys, tokens, passwords, or private keys in memory.` },
        isError: true,
      };
    }

    // Global scope
    if (scope === "global") {
      const globalMemory = context.globalMemory;
      if (!globalMemory) {
        return {
          data: { message: "Global user memory is not available in this session." },
          isError: true,
        };
      }

      const globalType = (["preference", "workflow", "environment", "feedback", "reference"].includes(input.type)
        ? input.type
        : "preference") as "preference" | "workflow" | "environment" | "feedback" | "reference";

      const existing = globalMemory.readEntry(input.name);
      globalMemory.writeEntry({
        name: input.name,
        type: globalType,
        description: input.description,
        body: input.body,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        provenance: {
          source: "memory_tool",
          sessionId: undefined,
          projectId: context.projectMemory?.projectId,
          cwd: context.cwd,
        },
      });

      const saved = globalMemory.readEntry(input.name);
      if (!saved) {
        return {
          data: { message: `Global memory entry could not be reloaded after write: ${input.name}` },
          isError: true,
        };
      }

      return {
        data: {
          name: saved.name,
          filePath: saved.filePath,
          isNew: existing == null,
          scope: "global",
        },
      };
    }

    // Project scope (default)
    const projectMemory = context.projectMemory;
    if (!projectMemory) {
      return {
        data: { message: "Project memory is not available in this session." },
        isError: true,
      };
    }

    // Map global types to closest project type
    const projectType = (
      input.type === "preference" || input.type === "workflow" || input.type === "environment"
        ? "user"
        : input.type
    ) as "user" | "feedback" | "project" | "reference";

    const existing = projectMemory.readEntry(input.name);
    projectMemory.writeEntry({
      name: input.name,
      type: projectType,
      description: input.description,
      body: input.body,
      filePath: existing?.filePath ?? "",
    });

    const saved = projectMemory.readEntry(input.name);
    if (!saved) {
      return {
        data: { message: `Memory entry could not be reloaded after write: ${input.name}` },
        isError: true,
      };
    }

    return {
      data: {
        name: saved.name,
        filePath: saved.filePath,
        isNew: existing == null,
        scope: "project",
      },
    };
  },

  formatResult(output): string {
    if ("message" in output) {
      return `Error: ${output.message}`;
    }

    const scopeLabel = output.scope === "global" ? "[global] " : "";
    return output.isNew
      ? `${scopeLabel}Memory entry created: ${output.name} (${output.filePath})`
      : `${scopeLabel}Memory entry updated: ${output.name} (${output.filePath})`;
  },
});
