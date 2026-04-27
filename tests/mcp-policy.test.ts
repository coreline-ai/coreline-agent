/**
 * MCP operational policy tests.
 */

import { describe, expect, test } from "bun:test";
import { classifyMcpToolPermission, isLikelyReadOnlyMcpToolName } from "../src/mcp/policy.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import type { PermissionCheckContext } from "../src/permissions/types.js";

function makeCtx(rules: PermissionCheckContext["rules"] = []): PermissionCheckContext {
  return { cwd: "/tmp", mode: "default", rules };
}

describe("MCP policy helpers", () => {
  test("treats clearly read-only MCP tool names as read-only", () => {
    expect(isLikelyReadOnlyMcpToolName("docs:listPages")).toBe(true);
    expect(isLikelyReadOnlyMcpToolName("docs:readPage")).toBe(true);
    expect(isLikelyReadOnlyMcpToolName("docs:updatePage")).toBe(false);
  });

  test("classifies MCP tool permissions heuristically", () => {
    expect(classifyMcpToolPermission("docs:listPages")).toMatchObject({
      behavior: "allow",
      isReadOnly: true,
    });

    expect(classifyMcpToolPermission("docs:updatePage")).toMatchObject({
      behavior: "ask",
      isReadOnly: false,
    });
  });
});

describe("PermissionEngine MCP handling", () => {
  const engine = new PermissionEngine();

  test("allows clearly read-only MCP tools by default", () => {
    const result = engine.check("docs:listPages", {}, makeCtx());
    expect(result.behavior).toBe("allow");
    expect(result.reason).toContain("read-only");
  });

  test("asks for write-capable MCP tools by default", () => {
    const result = engine.check("docs:updatePage", {}, makeCtx());
    expect(result.behavior).toBe("ask");
    expect(result.reason).toContain("confirmation");
  });

  test("honors explicit deny rules for MCP tools", () => {
    const result = engine.check(
      "docs:listPages",
      {},
      makeCtx([{ behavior: "deny", toolName: "docs:listPages" }]),
    );
    expect(result.behavior).toBe("deny");
  });
});
