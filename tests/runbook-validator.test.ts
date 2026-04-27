/**
 * Wave 10 P1 R3 — Runbook frontmatter validator tests.
 */

import { describe, expect, test } from "bun:test";
import { validateRunbookRecord } from "../src/agent/runbook/runbook-validator.js";

const VALID_FM = {
  id: "rb-deadbeef",
  type: "runbook",
  pattern: "pool exhaustion",
  confidence: 0.7,
  usageCount: 3,
  sourceIncidents: [],
  createdAt: "2026-04-25T12:00:00Z",
  updatedAt: "2026-04-25T12:00:00Z",
  tier: "recall",
  tags: [],
};

const VALID_SECTIONS = {
  steps: ["Restart pool", "Verify healthy"],
  symptom: "pool exhaustion",
};

describe("validateRunbookRecord — Wave 10 P1 R3", () => {
  test("valid full record returns ok", () => {
    const r = validateRunbookRecord({ frontmatter: VALID_FM, sections: VALID_SECTIONS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.id).toBe("rb-deadbeef");
      expect(r.record.confidence).toBe(0.7);
      expect(r.record.steps).toEqual(["Restart pool", "Verify healthy"]);
    }
  });

  test("invalid id format → error", () => {
    const r = validateRunbookRecord({
      frontmatter: { ...VALID_FM, id: "rb-XYZ" },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  test("confidence out of range → error", () => {
    const r = validateRunbookRecord({
      frontmatter: { ...VALID_FM, confidence: 1.5 },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("confidence");
  });

  test("invalid tier → error", () => {
    const r = validateRunbookRecord({
      frontmatter: { ...VALID_FM, tier: "weird" },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tier");
  });

  test("empty steps → error", () => {
    const r = validateRunbookRecord({
      frontmatter: VALID_FM,
      sections: { ...VALID_SECTIONS, steps: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("steps");
  });

  test("usageCount negative → error", () => {
    const r = validateRunbookRecord({
      frontmatter: { ...VALID_FM, usageCount: -1 },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("usageCount");
  });
});
