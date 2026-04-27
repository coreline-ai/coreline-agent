/**
 * Phase 3 — AI slop detector tests.
 * Patterns adapted from huashu-design content guidelines (independent rewrite).
 */

import { describe, expect, test } from "bun:test";
import {
  detectAISlopSignals,
  formatSlopReport,
  type SlopSignal,
} from "../src/agent/reliability/slop-detector.js";

describe("slop detector — pattern coverage", () => {
  test("flags generic purple/pink gradient", () => {
    const css = ".hero { background: linear-gradient(135deg, #9333ea, #ec4899); }";
    const signals = detectAISlopSignals(css);
    expect(signals.some((s) => s.patternId === "purple-gradient")).toBe(true);
  });

  test("does not flag warm-tone single gradient", () => {
    const css = ".hero { background: linear-gradient(to right, #ff6633, #f08080); }";
    const signals = detectAISlopSignals(css);
    expect(signals.some((s) => s.patternId === "purple-gradient")).toBe(false);
  });

  test("flags decorative emoji inside heading", () => {
    const html = "<h2>Features 🚀</h2>";
    const signals = detectAISlopSignals(html);
    expect(signals.some((s) => s.patternId === "decorative-emoji")).toBe(true);
  });

  test("does not flag emoji in plain prose", () => {
    const text = "I love coffee ☕ and pastries every morning.";
    const signals = detectAISlopSignals(text);
    expect(signals.some((s) => s.patternId === "decorative-emoji")).toBe(false);
  });

  test("flags rounded card with left border accent", () => {
    const css =
      ".card { border-radius: 12px; padding: 16px; border-left: 4px solid #4f46e5; }";
    const signals = detectAISlopSignals(css);
    expect(signals.some((s) => s.patternId === "rounded-card-left-accent")).toBe(true);
  });

  test("flags Inter without serif pairing", () => {
    const css = "body { font-family: 'Inter', sans-serif; }";
    const signals = detectAISlopSignals(css);
    expect(signals.some((s) => s.patternId === "inter-display-font")).toBe(true);
  });

  test("does not flag Inter when paired with Source Serif", () => {
    const css = `
      body { font-family: 'Inter', sans-serif; }
      h1 { font-family: 'Source Serif 4', serif; }
    `;
    const signals = detectAISlopSignals(css);
    expect(signals.some((s) => s.patternId === "inter-display-font")).toBe(false);
  });

  test("flags AI cliché phrases", () => {
    const text = "We seamlessly leverage cutting-edge tech to elevate users.";
    const signals = detectAISlopSignals(text);
    expect(signals.some((s) => s.patternId === "generic-cliche-words")).toBe(true);
  });

  test("returns no signals for clean prose", () => {
    const text = "Our app stores recipes locally and syncs to your phone weekly.";
    const signals = detectAISlopSignals(text);
    expect(signals).toEqual([]);
  });

  test("flags excessive color palette (>5 distinct hex)", () => {
    const css = `
      .a { color: #111111; }
      .b { color: #222222; }
      .c { color: #333333; }
      .d { color: #444444; }
      .e { color: #555555; }
      .f { color: #666666; }
      .g { color: #777777; }
    `;
    const signals = detectAISlopSignals(css);
    expect(signals.some((s) => s.patternId === "excessive-color-palette")).toBe(true);
  });

  test("flags lorem ipsum as error severity", () => {
    const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
    const signals = detectAISlopSignals(text);
    const lorem = signals.find((s) => s.patternId === "lorem-ipsum-content");
    expect(lorem).toBeDefined();
    expect(lorem?.severity).toBe("error");
  });

  test("returns empty array for empty string", () => {
    expect(detectAISlopSignals("")).toEqual([]);
  });

  test("formatSlopReport returns success message when empty", () => {
    expect(formatSlopReport([])).toBe("No obvious AI slop detected.");
  });

  test("formatSlopReport includes pattern, severity, and suggestion", () => {
    const sig: SlopSignal = {
      patternId: "purple-gradient",
      description: "Generic purple/pink/blue gradient — overused AI default",
      suggestion: "Use single-color gradients or flat brand colors from your palette",
      severity: "warning",
      matchedText: "linear-gradient(135deg, #9333ea",
    };
    const report = formatSlopReport([sig]);
    expect(report).toContain("WARNING");
    expect(report).toContain("purple-gradient");
    expect(report).toContain("Use single-color gradients");
    expect(report).toContain("matched: linear-gradient(135deg, #9333ea");
  });

  test("formatSlopReport summarizes mixed severity counts", () => {
    const signals: SlopSignal[] = [
      {
        patternId: "lorem-ipsum-content",
        description: "lorem",
        suggestion: "replace",
        severity: "error",
      },
      {
        patternId: "purple-gradient",
        description: "purple",
        suggestion: "use brand",
        severity: "warning",
      },
    ];
    const report = formatSlopReport(signals);
    expect(report).toContain("1 error(s)");
    expect(report).toContain("1 warning(s)");
  });
});
