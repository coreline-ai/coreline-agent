/**
 * Wave 10 P1 R3 — Decision frontmatter validator tests.
 */

import { describe, expect, test } from "bun:test";
import { validateDecisionRecord } from "../src/agent/decision/decision-validator.js";

const VALID_FM = {
  id: "dec-20260425-adopt-strict-mode",
  type: "decision",
  title: "Adopt strict mode",
  status: "accepted",
  decidedAt: "2026-04-25T12:00:00Z",
  validFrom: "2026-04-25T12:00:00Z",
  recordedAt: "2026-04-25T12:01:00Z",
  tier: "core",
  source: "manual",
  tags: ["typescript"],
  linkedIncidents: [],
};

const VALID_SECTIONS = {
  what: "Adopt TypeScript strict mode",
  why: "Catch type errors early",
  how: "Set strict:true in tsconfig",
};

describe("validateDecisionRecord — Wave 10 P1 R3", () => {
  test("valid full record returns ok", () => {
    const r = validateDecisionRecord({ frontmatter: VALID_FM, sections: VALID_SECTIONS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.id).toBe("dec-20260425-adopt-strict-mode");
      expect(r.record.status).toBe("accepted");
      expect(r.record.what).toBe("Adopt TypeScript strict mode");
    }
  });

  test("invalid status 'weird' → error", () => {
    const r = validateDecisionRecord({
      frontmatter: { ...VALID_FM, status: "weird" },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("status");
  });

  test("invalid id format → error", () => {
    const r = validateDecisionRecord({
      frontmatter: { ...VALID_FM, id: "decision-bad" },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  test("missing 'what' body section → error", () => {
    const r = validateDecisionRecord({
      frontmatter: VALID_FM,
      sections: { ...VALID_SECTIONS, what: "" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("what");
  });

  test("missing recordedAt → error", () => {
    const fm = { ...VALID_FM };
    delete (fm as Record<string, unknown>).recordedAt;
    const r = validateDecisionRecord({ frontmatter: fm, sections: VALID_SECTIONS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("recordedAt");
  });

  test("optional fields default correctly", () => {
    const fm: Record<string, unknown> = {
      id: "dec-20260425-min",
      title: "Minimal",
      status: "proposed",
      decidedAt: "2026-04-25T12:00:00Z",
      validFrom: "2026-04-25T12:00:00Z",
      recordedAt: "2026-04-25T12:00:00Z",
    };
    const r = validateDecisionRecord({ frontmatter: fm, sections: VALID_SECTIONS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.tier).toBe("core"); // default for proposed
      expect(r.record.source).toBe("manual");
      expect(r.record.tags).toEqual([]);
      expect(r.record.linkedIncidents).toEqual([]);
    }
  });
});
