/**
 * brand-spec memory type — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Helpers to create + validate brand spec memory entries.
 */

import { todayIso } from "./tiering.js";
import type { BrandSpecFields, BrandSpecValidationResult } from "./brand-spec-types.js";
import type { MemoryEntry } from "./types.js";

const REQUIRED_SECTIONS = ["## Core Identity", "## Typography", "## Tone"] as const;

const LOGO_PLACEHOLDER = "(path or URL)";
const PRIMARY_PLACEHOLDER_PATTERNS = ["(hex / oklch)"] as const;

/**
 * Brand-spec entries are stored under the `brand-spec-<name>` slug so they sit
 * alongside other typed memory entries without name collisions.
 */
export function brandSpecEntryName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  return `brand-spec-${slug}`;
}

/**
 * Create a markdown template for a new brand-spec.
 * Text is written independently of huashu-design source materials.
 */
export function createBrandSpecTemplate(name: string): string {
  const today = todayIso();
  const safeName = name.trim() || "untitled";
  return [
    `# Brand Spec: ${safeName}`,
    "",
    `> Created: ${today}`,
    `> Memory type: brand-spec (auto-tier: core)`,
    "",
    "## Core Identity",
    "",
    `- **Logo**: ${LOGO_PLACEHOLDER}`,
    "- **Primary color**: (hex / oklch)",
    "- **Accent color**: (single color, optional)",
    "- **Background**: (hex / theme)",
    "",
    "## Typography",
    "",
    "- **Display**: (heading font — serif recommended)",
    "- **Body**: (paragraph font — sans-serif)",
    "- **Monospace**: (code font)",
    "",
    "## Tone",
    "",
    "3-5 adjectives describing the brand voice and visual mood.",
    "",
    "## Do not use",
    "",
    `Patterns to actively avoid (e.g., "purple gradient", "decorative emoji", "Material rounded cards").`,
    "",
    "## Notes",
    "",
    "Free-form additional context.",
    "",
  ].join("\n");
}

/**
 * Validate brand-spec body markdown — checks required sections + reasonable values.
 * Returns valid=false on structural issues, but never throws.
 */
export function validateBrandSpec(body: string): BrandSpecValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof body !== "string" || body.trim().length === 0) {
    errors.push("Body is empty.");
    return { valid: false, errors, warnings };
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  // Heuristic placeholder detection — extract bullet values for Logo / Primary.
  const logoMatch = body.match(/\*\*Logo\*\*:\s*([^\n]*)/i);
  if (logoMatch) {
    const value = (logoMatch[1] ?? "").trim();
    if (!value || value === LOGO_PLACEHOLDER) {
      warnings.push("Logo value is a placeholder — fill in a real path or URL.");
    }
  }

  const primaryMatch = body.match(/\*\*Primary color\*\*:\s*([^\n]*)/i);
  if (primaryMatch) {
    const value = (primaryMatch[1] ?? "").trim();
    if (!value || PRIMARY_PLACEHOLDER_PATTERNS.includes(value as (typeof PRIMARY_PLACEHOLDER_PATTERNS)[number])) {
      warnings.push("Primary color is empty or still a placeholder.");
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Parse a brand-spec memory entry's body into structured fields.
 * Best-effort — missing fields stay undefined.
 */
export function parseBrandSpecBody(body: string): BrandSpecFields {
  const fields: BrandSpecFields = { name: "" };

  const titleMatch = body.match(/^#\s+Brand Spec:\s*(.+)$/m);
  if (titleMatch) {
    fields.name = (titleMatch[1] ?? "").trim();
  }

  const bullet = (label: string): string | undefined => {
    const re = new RegExp(`\\*\\*${escapeRegex(label)}\\*\\*:\\s*([^\\n]*)`, "i");
    const match = body.match(re);
    if (!match) return undefined;
    const value = (match[1] ?? "").trim();
    if (!value || isPlaceholder(value)) return undefined;
    return value;
  };

  fields.logo = bullet("Logo");
  fields.primaryColor = bullet("Primary color");
  fields.accentColor = bullet("Accent color");
  fields.backgroundColor = bullet("Background");
  fields.displayFont = bullet("Display");
  fields.bodyFont = bullet("Body");
  fields.monoFont = bullet("Monospace");

  const toneSection = extractSection(body, "## Tone");
  if (toneSection) {
    const adjectives = toneSection
      .split(/[,\n]/)
      .map((s) => s.replace(/^[-*\s]+/, "").trim())
      .filter((s) => s.length > 0 && !s.startsWith("3-5 adjectives"));
    if (adjectives.length > 0) fields.tone = adjectives;
  }

  const doNotUseSection = extractSection(body, "## Do not use");
  if (doNotUseSection) {
    const lines = doNotUseSection
      .split(/\n/)
      .map((s) => s.replace(/^[-*\s]+/, "").trim())
      .filter((s) => s.length > 0 && !s.startsWith("Patterns to actively avoid"));
    if (lines.length > 0) fields.doNotUse = lines;
  }

  const notesSection = extractSection(body, "## Notes");
  if (notesSection) {
    const trimmed = notesSection.trim();
    if (trimmed && !trimmed.startsWith("Free-form additional context")) {
      fields.notes = trimmed;
    }
  }

  return fields;
}

/**
 * Build a MemoryEntry for a brand-spec.
 * Defaults: tier="core", importance="high".
 */
export function buildBrandSpecEntry(
  name: string,
  body?: string,
): Omit<MemoryEntry, "filePath"> {
  const safeName = name.trim();
  if (!safeName) {
    throw new Error("brand-spec name is required");
  }
  const finalBody = body ?? createBrandSpecTemplate(safeName);
  return {
    name: brandSpecEntryName(safeName),
    description: `Brand spec for ${safeName}`,
    type: "brand-spec",
    body: finalBody,
    tier: "core",
    importance: "high",
    recordedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlaceholder(value: string): boolean {
  if (value === LOGO_PLACEHOLDER) return true;
  if (value.startsWith("(") && value.endsWith(")")) return true;
  return false;
}

function extractSection(body: string, header: string): string | undefined {
  const idx = body.indexOf(header);
  if (idx < 0) return undefined;
  const after = body.slice(idx + header.length);
  const nextHeaderMatch = after.match(/\n##\s+/);
  const end = nextHeaderMatch ? nextHeaderMatch.index ?? after.length : after.length;
  return after.slice(0, end).trim();
}
