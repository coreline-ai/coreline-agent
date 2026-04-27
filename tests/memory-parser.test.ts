/**
 * Memory parser tests — frontmatter, serialization, validation.
 */

import { describe, test, expect } from "bun:test";
import {
  parseMemoryFile,
  serializeMemoryFile,
  validateMemoryType,
} from "../src/memory/memory-parser.js";

describe("Memory parser", () => {
  test("parses frontmatter and body", () => {
    const parsed = parseMemoryFile(`---\nname: user_profile\ndescription: Bun setup\ntype: user\n---\nUse Bun.`);
    expect(parsed.frontmatter.name).toBe("user_profile");
    expect(parsed.frontmatter.description).toBe("Bun setup");
    expect(parsed.frontmatter.type).toBe("user");
    expect(parsed.body).toBe("Use Bun.");
  });

  test("falls back to whole content when no frontmatter exists", () => {
    const parsed = parseMemoryFile("plain markdown body");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("plain markdown body");
  });

  test("returns empty body for empty input", () => {
    expect(parseMemoryFile("")).toEqual({ frontmatter: {}, body: "" });
  });

  test("validateMemoryType accepts supported types", () => {
    expect(validateMemoryType("user")).toBe(true);
    expect(validateMemoryType("feedback")).toBe(true);
    expect(validateMemoryType("project")).toBe(true);
    expect(validateMemoryType("reference")).toBe(true);
    expect(validateMemoryType("invalid")).toBe(false);
  });

  test("serialize and parse roundtrip preserves fields", () => {
    const source = {
      name: "user_profile",
      description: "Preferred runtime",
      type: "user" as const,
      body: "Bun only.\nStrict TS.",
    };

    const serialized = serializeMemoryFile(source);
    const parsed = parseMemoryFile(serialized);

    expect(parsed.frontmatter.name).toBe(source.name);
    expect(parsed.frontmatter.description).toBe(source.description);
    expect(parsed.frontmatter.type).toBe(source.type);
    expect(parsed.body).toBe(source.body);
  });
});

