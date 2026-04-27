/**
 * Provider shortcut tests — keyboard-based provider switching helpers.
 */

import { describe, test, expect } from "bun:test";
import { resolveCycleProvider, resolveNumericProvider } from "../src/tui/provider-shortcut.js";

const PROVIDERS = ["local-qwen", "local-gemma", "gemini", "chatgpt", "claude"];

describe("resolveCycleProvider", () => {
  test("next wraps around from last to first", () => {
    expect(resolveCycleProvider(PROVIDERS, "claude", "next")).toBe("local-qwen");
  });

  test("next advances one position", () => {
    expect(resolveCycleProvider(PROVIDERS, "local-qwen", "next")).toBe("local-gemma");
    expect(resolveCycleProvider(PROVIDERS, "gemini", "next")).toBe("chatgpt");
  });

  test("previous wraps around from first to last", () => {
    expect(resolveCycleProvider(PROVIDERS, "local-qwen", "previous")).toBe("claude");
  });

  test("previous moves one position back", () => {
    expect(resolveCycleProvider(PROVIDERS, "gemini", "previous")).toBe("local-gemma");
  });

  test("returns null when only 1 provider exists", () => {
    expect(resolveCycleProvider(["only"], "only", "next")).toBeNull();
    expect(resolveCycleProvider(["only"], "only", "previous")).toBeNull();
  });

  test("returns null when no providers exist", () => {
    expect(resolveCycleProvider([], "whatever", "next")).toBeNull();
  });

  test("current not in list → falls back to index 0, returns name at nextIdx", () => {
    expect(resolveCycleProvider(PROVIDERS, "unknown", "next")).toBe("local-gemma");
    expect(resolveCycleProvider(PROVIDERS, "unknown", "previous")).toBe("claude");
  });
});

describe("resolveNumericProvider", () => {
  test("Ctrl+1 → first provider", () => {
    expect(resolveNumericProvider(PROVIDERS, "1")).toBe("local-qwen");
  });

  test("Ctrl+3 → third provider", () => {
    expect(resolveNumericProvider(PROVIDERS, "3")).toBe("gemini");
  });

  test("Ctrl+5 → fifth provider", () => {
    expect(resolveNumericProvider(PROVIDERS, "5")).toBe("claude");
  });

  test("out-of-range returns null", () => {
    expect(resolveNumericProvider(PROVIDERS, "6")).toBeNull();
    expect(resolveNumericProvider(PROVIDERS, "9")).toBeNull();
  });

  test("non-digit input returns null", () => {
    expect(resolveNumericProvider(PROVIDERS, "a")).toBeNull();
    expect(resolveNumericProvider(PROVIDERS, "")).toBeNull();
    expect(resolveNumericProvider(PROVIDERS, "10")).toBeNull();
  });

  test("zero returns null (Ctrl+0 reserved/unused)", () => {
    expect(resolveNumericProvider(PROVIDERS, "0")).toBeNull();
  });

  test("empty provider list returns null", () => {
    expect(resolveNumericProvider([], "1")).toBeNull();
  });
});
