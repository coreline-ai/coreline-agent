/**
 * Phase 3 — /slop-check TUI handler tests.
 * Concept inspired by huashu-design (independent implementation).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlopCheck } from "../src/tui/handlers/slop-handler.js";
import { handleSlopCheck as routeSlopCheck } from "../src/tui/commands/slop-check.js";

describe("slop-check handler", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slop-handler-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("clean file returns no-slop message", async () => {
    const file = join(dir, "clean.css");
    writeFileSync(file, ".btn { color: #112233; padding: 8px; }");
    const out = await handleSlopCheck({ path: file }, { cwd: dir });
    expect(out).toContain("No obvious AI slop detected");
  });

  test("file with slop emits signals", async () => {
    const file = join(dir, "slop.css");
    writeFileSync(
      file,
      ".hero { background: linear-gradient(135deg, #9333ea, #ec4899); }",
    );
    const out = await handleSlopCheck({ path: file }, { cwd: dir });
    expect(out).toContain("purple-gradient");
    expect(out).toContain("WARNING");
  });

  test("missing file returns error message instead of throwing", async () => {
    const file = join(dir, "does-not-exist.css");
    const out = await handleSlopCheck({ path: file }, { cwd: dir });
    expect(out.startsWith("Error:")).toBe(true);
  });

  test("relative path resolved against cwd", async () => {
    writeFileSync(join(dir, "rel.css"), "body { font-family: 'Inter'; }");
    const out = await handleSlopCheck({ path: "rel.css" }, { cwd: dir });
    expect(out).toContain("inter-display-font");
  });

  test("empty path returns usage", async () => {
    const out = await handleSlopCheck({ path: "" }, { cwd: dir });
    expect(out).toBe("Usage: /slop-check <file-path>");
  });
});

describe("slop-check sub-router", () => {
  test("returns null for unrelated commands", () => {
    expect(routeSlopCheck("fact", ["foo"])).toBeNull();
  });

  test("usage when no path", () => {
    const r = routeSlopCheck("slop-check", []);
    expect(r?.handled).toBe(true);
    expect(r?.output).toContain("Usage:");
  });

  test("emits slop_check action with path data", () => {
    const r = routeSlopCheck("slop-check", ["src/foo.css"]);
    expect(r?.action).toBe("slop_check");
    expect(r?.data).toEqual({ path: "src/foo.css" });
  });
});
