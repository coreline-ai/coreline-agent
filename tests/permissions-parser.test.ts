import { describe, test, expect } from "bun:test";
import { parseRuleExpression } from "../src/permissions/parser.js";

describe("permission parser", () => {
  test("parses Bash(git *)", () => {
    expect(parseRuleExpression("Bash(git *)")).toEqual({
      toolName: "Bash",
      pattern: "git *",
    });
  });

  test("parses FileRead(src/**/*.ts)", () => {
    expect(parseRuleExpression("FileRead(src/**/*.ts)")).toEqual({
      toolName: "FileRead",
      pattern: "src/**/*.ts",
    });
  });

  test("keeps escaped characters in pattern text", () => {
    expect(parseRuleExpression(String.raw`Bash(echo \*)`)).toEqual({
      toolName: "Bash",
      pattern: String.raw`echo \*`,
    });
  });

  test("returns null for malformed expressions", () => {
    expect(parseRuleExpression("Bashgit *")).toBeNull();
    expect(parseRuleExpression("Bash(git *")).toBeNull();
    expect(parseRuleExpression("(git *)")).toBeNull();
    expect(parseRuleExpression("")).toBeNull();
  });
});
