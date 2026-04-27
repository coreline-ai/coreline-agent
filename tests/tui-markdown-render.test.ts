/**
 * Minimal markdown rendering tests for TUI output.
 */

import React from "react";
import { describe, expect, test } from "bun:test";
import {
  parseInlineMarkdown,
  parseMinimalMarkdown,
  renderMinimalMarkdown,
} from "../src/tui/streaming-output.js";

describe("TUI markdown rendering", () => {
  test("parses inline strong and code spans", () => {
    expect(parseInlineMarkdown("Use **bold** and `code` now")).toEqual([
      { type: "text", text: "Use " },
      { type: "strong", text: "bold" },
      { type: "text", text: " and " },
      { type: "code", text: "code" },
      { type: "text", text: " now" },
    ]);
  });

  test("parses fenced code blocks with language hints", () => {
    expect(
      parseMinimalMarkdown("Intro\n```ts\nconst x = 1;\n```\nEnd"),
    ).toEqual([
      { type: "text", segments: [{ type: "text", text: "Intro" }] },
      { type: "fence-start", marker: "```", language: "ts" },
      { type: "code", text: "const x = 1;" },
      { type: "fence-end", marker: "```" },
      { type: "text", segments: [{ type: "text", text: "End" }] },
    ]);
  });

  test("renders fence markers and code lines as separate nodes", () => {
    const nodes = renderMinimalMarkdown("```ts\nconst x = 1;\n```");

    expect(nodes).toHaveLength(3);
    expect(React.isValidElement(nodes[0])).toBe(true);
    expect((nodes[0] as any).props.children).toBe("``` ts");
    expect((nodes[1] as any).props.children[0]).toBe("const x = 1;");
    expect((nodes[2] as any).props.children).toBe("```");
  });
});
