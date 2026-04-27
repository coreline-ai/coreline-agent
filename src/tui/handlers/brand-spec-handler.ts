/**
 * brand-spec handler — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Renders /memory brand-spec init|view|edit results.
 */

import {
  brandSpecEntryName,
  buildBrandSpecEntry,
  createBrandSpecTemplate,
  validateBrandSpec,
} from "../../memory/brand-spec.js";
import type { HandlerContext } from "./types.js";

export interface BrandSpecCommandData {
  command: "init" | "view" | "edit";
  name: string;
}

export async function handleBrandSpecCommand(
  data: BrandSpecCommandData,
  context: HandlerContext,
): Promise<string> {
  const { projectMemory } = context;
  const { command, name } = data;

  if (!name || !name.trim()) {
    return `Usage: /memory brand-spec ${command} <name>`;
  }

  const slug = brandSpecEntryName(name);

  try {
    if (command === "init") {
      const existing = projectMemory.readEntry(slug);
      if (existing) {
        const validation = validateBrandSpec(existing.body);
        const warningSuffix = renderWarnings(validation.warnings);
        return [
          `Brand spec already exists: ${slug}`,
          `File: ${existing.filePath}`,
          "",
          existing.body,
          warningSuffix,
        ]
          .filter((s) => s.length > 0)
          .join("\n");
      }
      const template = createBrandSpecTemplate(name);
      const entry = buildBrandSpecEntry(name, template);
      projectMemory.writeEntry({ ...entry, filePath: "" });
      const written = projectMemory.readEntry(slug);
      const filePath = written?.filePath ?? "(unknown)";
      return [
        `Brand spec initialized: ${slug}`,
        `File: ${filePath}`,
        "",
        "Edit the file to fill in colors, fonts, and tone.",
      ].join("\n");
    }

    if (command === "view") {
      const entry = projectMemory.readEntry(slug);
      if (!entry) {
        return `Brand spec not found. Run /memory brand-spec init ${name}`;
      }
      const validation = validateBrandSpec(entry.body);
      const warningSuffix = renderWarnings(validation.warnings);
      return [entry.body, warningSuffix].filter((s) => s.length > 0).join("\n");
    }

    if (command === "edit") {
      const entry = projectMemory.readEntry(slug);
      if (!entry) {
        return `Brand spec not found. Run /memory brand-spec init ${name}`;
      }
      return `Edit at: ${entry.filePath}`;
    }

    return `Unknown brand-spec command: ${command}`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const lines = ["", "Warnings:", ...warnings.map((w) => `- ${w}`)];
  return lines.join("\n");
}
