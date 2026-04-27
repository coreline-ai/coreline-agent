import { describe, test, expect } from "bun:test";
import { matchesPermissionRule, compilePermissionPattern } from "../src/permissions/matcher.js";
import type { PermissionRule } from "../src/permissions/types.js";

function rule(partial: Partial<PermissionRule> & Pick<PermissionRule, "behavior" | "toolName">): PermissionRule {
  return {
    behavior: partial.behavior,
    toolName: partial.toolName,
    pattern: partial.pattern,
  };
}

describe("permission matcher", () => {
  test("matches exact Bash command", () => {
    const r = rule({ behavior: "allow", toolName: "Bash", pattern: "npm test" });

    expect(matchesPermissionRule(r, "Bash", { command: "npm test" })).toBe(true);
    expect(matchesPermissionRule(r, "Bash", { command: "npm run build" })).toBe(false);
  });

  test("matches wildcard patterns", () => {
    const r = rule({ behavior: "allow", toolName: "Bash", pattern: "git *" });

    expect(matchesPermissionRule(r, "Bash", { command: "git status" })).toBe(true);
    expect(matchesPermissionRule(r, "Bash", { command: "git commit -m 'msg'" })).toBe(true);
  });

  test("trailing space-star makes args optional", () => {
    const r = rule({ behavior: "allow", toolName: "Bash", pattern: "git *" });

    expect(matchesPermissionRule(r, "Bash", { command: "git" })).toBe(true);
    expect(matchesPermissionRule(r, "Bash", { command: "git   " })).toBe(true);
  });

  test("supports escaped star and backslash", () => {
    const starRule = rule({ behavior: "allow", toolName: "Bash", pattern: String.raw`echo \*` });
    const backslashRule = rule({ behavior: "allow", toolName: "Bash", pattern: String.raw`echo \\tmp` });

    expect(matchesPermissionRule(starRule, "Bash", { command: "echo *" })).toBe(true);
    expect(matchesPermissionRule(starRule, "Bash", { command: "echo star" })).toBe(false);
    expect(matchesPermissionRule(backslashRule, "Bash", { command: String.raw`echo \tmp` })).toBe(true);
  });

  test("supports FileRead path patterns", () => {
    const r = rule({ behavior: "allow", toolName: "FileRead", pattern: "src/**/*.ts" });

    expect(matchesPermissionRule(r, "FileRead", { file_path: "src/index.ts" })).toBe(true);
    expect(matchesPermissionRule(r, "FileRead", { file_path: "src/components/app.ts" })).toBe(true);
    expect(matchesPermissionRule(r, "FileRead", { file_path: "src/components/app.js" })).toBe(false);
  });

  test("toolName wildcard matches any tool", () => {
    const r = rule({ behavior: "allow", toolName: "*", pattern: "npm test" });

    expect(matchesPermissionRule(r, "Bash", { command: "npm test" })).toBe(true);
  });

  test("compilePermissionPattern returns null for malformed escape", () => {
    const malformed = "git " + "\\";
    expect(compilePermissionPattern(malformed)).toBeNull();
  });
});
