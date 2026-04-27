/**
 * One-time fixture generator for tests/fixtures/frontmatter-snapshots/.
 *
 * Wave 10 P3 O4 — produces 12 diverse memory files via the actual
 * `serializeMemoryFile` so that broad-coverage snapshot tests can assert
 * byte-identical roundtrips for every frontmatter field shape we support.
 *
 * Usage: bun run scripts/generate-frontmatter-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeMemoryFile } from "../src/memory/memory-parser.js";

const dir = join(import.meta.dir, "..", "tests", "fixtures", "frontmatter-snapshots");
mkdirSync(dir, { recursive: true });

const fixtures: Array<{ file: string; content: string }> = [];

// 1. Legacy minimal — Wave 1-6 baseline (name/description/type only).
fixtures.push({
  file: "legacy-minimal.md",
  content: serializeMemoryFile({
    name: "minimal",
    description: "A minimal legacy entry",
    type: "user",
    body: "Body text here.",
  }),
});

// 2. Legacy + tier.
fixtures.push({
  file: "legacy-with-tier.md",
  content: serializeMemoryFile({
    name: "with-tier",
    description: "Legacy plus tier",
    type: "feedback",
    body: "Feedback body.",
    tier: "core",
  }),
});

// 3. Legacy + tier + access tracking.
fixtures.push({
  file: "legacy-with-tier-and-access.md",
  content: serializeMemoryFile({
    name: "with-access",
    description: "Tier and access counters",
    type: "project",
    body: "Project body.",
    tier: "recall",
    lastAccessed: "2026-04-20T12:00:00.000Z",
    accessCount: 7,
  }),
});

// 4. Wave 1-6 full — all 8 baseline fields.
fixtures.push({
  file: "wave6-full.md",
  content: serializeMemoryFile({
    name: "wave6-full",
    description: "All Wave 1-6 fields populated",
    type: "user",
    body: "Wave 6 body.",
    tier: "archival",
    lastAccessed: "2026-04-25T08:30:00.000Z",
    accessCount: 12,
    importance: "high",
  }),
});

// 5. Wave 7 decay-only (decay weight + count).
fixtures.push({
  file: "wave7-decay-only.md",
  content: serializeMemoryFile({
    name: "decay-only",
    description: "Wave 7 decay fields",
    type: "reference",
    body: "Reference body for decay test.",
    tier: "recall",
    lastAccessed: "2026-04-15T00:00:00.000Z",
    accessCount: 3,
    importance: "medium",
    decayWeight: 0.625,
    decayCount: 2,
  }),
});

// 6. Wave 7 tombstoned.
fixtures.push({
  file: "wave7-tombstoned.md",
  content: serializeMemoryFile({
    name: "tombstoned-entry",
    description: "Soft-deleted entry",
    type: "user",
    body: "Body retained for audit.",
    tier: "archival",
    importance: "low",
    tombstoned: true,
    tombstonedAt: "2026-04-22T10:15:00.000Z",
  }),
});

// 7. Wave 7 bitemporal — validFrom/validTo/recordedAt.
fixtures.push({
  file: "wave7-bitemporal.md",
  content: serializeMemoryFile({
    name: "bitemporal",
    description: "Bitemporal validity windows",
    type: "reference",
    body: "Fact body.",
    tier: "core",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-31T23:59:59.000Z",
    recordedAt: "2026-04-26T00:00:00.000Z",
  }),
});

// 8. Wave 7 full — all 14 fields populated.
fixtures.push({
  file: "wave7-full.md",
  content: serializeMemoryFile({
    name: "wave7-full",
    description: "Every supported frontmatter field",
    type: "feedback",
    body: "Comprehensive body.",
    tier: "core",
    lastAccessed: "2026-04-26T01:02:03.000Z",
    accessCount: 42,
    importance: "high",
    decayWeight: 0.875,
    decayCount: 1,
    tombstoned: false,
    tombstonedAt: "2026-04-01T00:00:00.000Z",
    validFrom: "2026-02-01T00:00:00.000Z",
    validTo: "2027-02-01T00:00:00.000Z",
    recordedAt: "2026-04-26T02:00:00.000Z",
  }),
});

// 9. Korean content in name/description.
fixtures.push({
  file: "korean-content.md",
  content: serializeMemoryFile({
    name: "한글-메모리",
    description: "한국어 설명입니다",
    type: "user",
    body: "본문에도 한국어가 들어갑니다. 줄바꿈 포함.\n두 번째 줄.",
    tier: "core",
    importance: "medium",
  }),
});

// 10. Unicode + emoji body.
fixtures.push({
  file: "unicode-emoji.md",
  content: serializeMemoryFile({
    name: "unicode-emoji",
    description: "Body with emoji and unicode",
    type: "feedback",
    body: "Mix: ✅ 完成 🚀 — résumé café naïve. End.",
    tier: "recall",
    accessCount: 1,
  }),
});

// 11. Large body (>5000 chars).
const largeBody = Array.from({ length: 200 }, (_, i) =>
  `Line ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
).join("\n");
fixtures.push({
  file: "large-body.md",
  content: serializeMemoryFile({
    name: "large-body",
    description: "Body exceeding 5000 characters",
    type: "project",
    body: largeBody,
    tier: "archival",
    importance: "low",
    accessCount: 0,
  }),
});

// 12. Empty body.
fixtures.push({
  file: "empty-body.md",
  content: serializeMemoryFile({
    name: "empty-body",
    description: "Body deliberately empty",
    type: "reference",
    body: "",
    tier: "recall",
  }),
});

for (const { file, content } of fixtures) {
  writeFileSync(join(dir, file), content, "utf-8");
}

console.log(`Wrote ${fixtures.length} fixtures to ${dir}`);
