/**
 * Parser / serializer for memory markdown files.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MEMORY_INDEX_FILE } from "./constants.js";
import type { MemoryEntry, MemoryType, MemoryTier, MemoryImportance } from "./types.js";

const VALID_TIERS: readonly MemoryTier[] = ["core", "recall", "archival"];
const VALID_IMPORTANCE: readonly MemoryImportance[] = ["low", "medium", "high"];

export function validateMemoryTier(tier: unknown): tier is MemoryTier {
  return typeof tier === "string" && (VALID_TIERS as readonly string[]).includes(tier);
}

export function validateMemoryImportance(importance: unknown): importance is MemoryImportance {
  return typeof importance === "string" && (VALID_IMPORTANCE as readonly string[]).includes(importance);
}

function _coerceOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function _coerceOptionalBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Coerce/validate extended frontmatter fields. Invalid values → undefined
 * (silent fallback — we never want bad frontmatter to break a read).
 *
 * Wave 7-9 (v0.2 D17): `decayWeight` runtime fallback rule —
 * read result `undefined` is preserved here; consumers MUST use
 * `entry.decayWeight ?? DECAY_DEFAULT_WEIGHT (1.0)` pattern.
 */
export function extractExtendedFields(frontmatter: Record<string, unknown>): Pick<
  MemoryEntry,
  | "tier"
  | "lastAccessed"
  | "accessCount"
  | "importance"
  | "decayWeight"
  | "decayCount"
  | "tombstoned"
  | "tombstonedAt"
  | "validFrom"
  | "validTo"
  | "recordedAt"
> {
  const tier = validateMemoryTier(frontmatter.tier) ? frontmatter.tier : undefined;
  const lastAccessed = _coerceOptionalString(frontmatter.lastAccessed);
  const accessCountRaw = frontmatter.accessCount;
  const accessCount =
    typeof accessCountRaw === "number" && Number.isFinite(accessCountRaw) && accessCountRaw >= 0
      ? Math.floor(accessCountRaw)
      : undefined;
  const importance = validateMemoryImportance(frontmatter.importance) ? frontmatter.importance : undefined;

  // Decay fields (Wave 7 Phase 2)
  const decayWeightRaw = frontmatter.decayWeight;
  const decayWeight =
    typeof decayWeightRaw === "number" &&
    Number.isFinite(decayWeightRaw) &&
    decayWeightRaw >= 0 &&
    decayWeightRaw <= 1
      ? decayWeightRaw
      : undefined;
  const decayCountRaw = frontmatter.decayCount;
  const decayCount =
    typeof decayCountRaw === "number" && Number.isFinite(decayCountRaw) && decayCountRaw >= 0
      ? Math.floor(decayCountRaw)
      : undefined;
  const tombstoned = _coerceOptionalBoolean(frontmatter.tombstoned);
  const tombstonedAt = _coerceOptionalString(frontmatter.tombstonedAt);

  // Bitemporal fields (Wave 7 Phase 0 schema, used by Wave 8/9)
  const validFrom = _coerceOptionalString(frontmatter.validFrom);
  const validTo = _coerceOptionalString(frontmatter.validTo);
  const recordedAt = _coerceOptionalString(frontmatter.recordedAt);

  return {
    tier,
    lastAccessed,
    accessCount,
    importance,
    decayWeight,
    decayCount,
    tombstoned,
    tombstonedAt,
    validFrom,
    validTo,
    recordedAt,
  };
}

const MEMORY_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function validateMemoryType(type: string): type is MemoryType {
  return (
    type === "user" ||
    type === "feedback" ||
    type === "project" ||
    type === "reference" ||
    type === "brand-spec"
  );
}

export function parseMemoryFile(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content) {
    return { frontmatter: {}, body: "" };
  }

  const match = content.match(MEMORY_FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterSource = match[1] ?? "";
  const body = match[2] ?? "";

  try {
    const parsed = parseYaml(frontmatterSource);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body };
    }

    return { frontmatter: {}, body };
  } catch (error) {
    console.warn(`[memory] invalid frontmatter skipped: ${(error as Error).message}`);
    return { frontmatter: {}, body: content };
  }
}

export function serializeMemoryFile(
  entry: Pick<
    MemoryEntry,
    | "name"
    | "description"
    | "type"
    | "body"
    | "tier"
    | "lastAccessed"
    | "accessCount"
    | "importance"
    | "decayWeight"
    | "decayCount"
    | "tombstoned"
    | "tombstonedAt"
    | "validFrom"
    | "validTo"
    | "recordedAt"
  >,
): string {
  const raw: Record<string, unknown> = {
    name: entry.name,
    description: entry.description,
    type: entry.type,
    tier: entry.tier,
    lastAccessed: entry.lastAccessed,
    accessCount: entry.accessCount,
    importance: entry.importance,
    decayWeight: entry.decayWeight,
    decayCount: entry.decayCount,
    tombstoned: entry.tombstoned,
    tombstonedAt: entry.tombstonedAt,
    validFrom: entry.validFrom,
    validTo: entry.validTo,
    recordedAt: entry.recordedAt,
  };
  // Drop undefined fields so backward-compat serialization (tier=undefined)
  // produces output byte-identical to the pre-MemKraft shape.
  const filtered = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  );
  const frontmatter = stringifyYaml(filtered).trimEnd();

  return `---\n${frontmatter}\n---\n${entry.body ?? ""}`;
}

export function getMemoryIndexFileName(): string {
  return MEMORY_INDEX_FILE;
}

