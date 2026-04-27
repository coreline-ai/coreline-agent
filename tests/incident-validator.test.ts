/**
 * Wave 10 P1 R3 — Incident frontmatter validator tests.
 */

import { describe, expect, test } from "bun:test";
import { validateIncidentRecord } from "../src/agent/incident/incident-validator.js";

const VALID_FM = {
  id: "inc-20260425-120000-deadbeef",
  type: "incident",
  title: "API outage",
  severity: "high",
  status: "open",
  detectedAt: "2026-04-25T12:00:00Z",
  validFrom: "2026-04-25T12:00:00Z",
  recordedAt: "2026-04-25T12:01:00Z",
  tier: "core",
  source: "manual",
  affected: ["api"],
  tags: ["outage"],
};

const VALID_SECTIONS = {
  symptoms: ["503 errors observed"],
  evidence: [
    { type: "stderr", value: "ECONNRESET", collectedAt: "2026-04-25T12:00:00Z" },
  ],
  hypotheses: [
    { text: "proxy timeout", status: "testing", notedAt: "2026-04-25T12:00:00Z" },
  ],
  resolution: undefined,
  related: [],
};

describe("validateIncidentRecord — Wave 10 P1 R3", () => {
  test("valid full record returns ok", () => {
    const r = validateIncidentRecord({ frontmatter: VALID_FM, sections: VALID_SECTIONS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.id).toBe("inc-20260425-120000-deadbeef");
      expect(r.record.severity).toBe("high");
      expect(r.record.status).toBe("open");
      expect(r.record.symptoms).toEqual(["503 errors observed"]);
      expect(r.record.evidence).toHaveLength(1);
      expect(r.record.hypotheses).toHaveLength(1);
    }
  });

  test("missing severity → error", () => {
    const fm = { ...VALID_FM };
    delete (fm as Record<string, unknown>).severity;
    const r = validateIncidentRecord({ frontmatter: fm, sections: VALID_SECTIONS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("severity");
  });

  test("invalid severity 'bogus' → error", () => {
    const r = validateIncidentRecord({
      frontmatter: { ...VALID_FM, severity: "bogus" },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("severity");
  });

  test("invalid id format → error", () => {
    const r = validateIncidentRecord({
      frontmatter: { ...VALID_FM, id: "not-an-incident-id" },
      sections: VALID_SECTIONS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  test("missing required validFrom → error", () => {
    const fm = { ...VALID_FM };
    delete (fm as Record<string, unknown>).validFrom;
    const r = validateIncidentRecord({ frontmatter: fm, sections: VALID_SECTIONS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("validFrom");
  });

  test("optional fields default correctly", () => {
    const fm: Record<string, unknown> = {
      id: "inc-20260425-120000-deadbeef",
      title: "minimal",
      severity: "low",
      status: "resolved",
      detectedAt: "2026-04-25T12:00:00Z",
      validFrom: "2026-04-25T12:00:00Z",
      recordedAt: "2026-04-25T12:00:00Z",
    };
    const r = validateIncidentRecord({
      frontmatter: fm,
      sections: { symptoms: [], evidence: [], hypotheses: [], related: [] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.tier).toBe("archival"); // default for resolved
      expect(r.record.source).toBe("manual");
      expect(r.record.affected).toEqual([]);
      expect(r.record.tags).toEqual([]);
      expect(r.record.symptoms).toEqual([]);
    }
  });

  test("invalid hypothesis status filtered out", () => {
    const r = validateIncidentRecord({
      frontmatter: VALID_FM,
      sections: {
        ...VALID_SECTIONS,
        hypotheses: [
          { text: "ok", status: "testing", notedAt: "2026-04-25" },
          { text: "bad", status: "weird", notedAt: "2026-04-25" }, // invalid
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.hypotheses).toHaveLength(1);
      expect(r.record.hypotheses[0]!.text).toBe("ok");
    }
  });
});
