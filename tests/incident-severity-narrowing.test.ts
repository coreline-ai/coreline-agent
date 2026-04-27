/**
 * Tests for severity narrowing helpers (Wave 10 P0 F2).
 */

import { describe, expect, test } from "bun:test";
import {
  isIncidentSeverity,
  narrowSeverity,
  narrowSeverityOrDefault,
} from "../src/agent/incident/severity-utils.js";

describe("severity narrowing", () => {
  test("valid severities narrow correctly", () => {
    expect(narrowSeverity("low")).toBe("low");
    expect(narrowSeverity("medium")).toBe("medium");
    expect(narrowSeverity("high")).toBe("high");
    expect(narrowSeverity("critical")).toBe("critical");
  });

  test("invalid string returns undefined", () => {
    expect(narrowSeverity("bogus")).toBeUndefined();
    expect(narrowSeverity("")).toBeUndefined();
    expect(narrowSeverity("LOW")).toBeUndefined(); // case-sensitive
  });

  test("non-string returns undefined", () => {
    expect(narrowSeverity(undefined)).toBeUndefined();
    expect(narrowSeverity(null)).toBeUndefined();
    expect(narrowSeverity(42)).toBeUndefined();
  });

  test("narrowSeverityOrDefault returns fallback", () => {
    expect(narrowSeverityOrDefault("bogus")).toBe("medium");
    expect(narrowSeverityOrDefault("bogus", "high")).toBe("high");
    expect(narrowSeverityOrDefault("low")).toBe("low");
  });

  test("isIncidentSeverity type guard", () => {
    expect(isIncidentSeverity("low")).toBe(true);
    expect(isIncidentSeverity("bogus")).toBe(false);
  });
});
