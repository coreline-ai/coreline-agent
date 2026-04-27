import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectContextCandidates, extractPathHints, extractSymbolHints } from "../src/agent/context-collector.js";
import { buildImportGraph, parseImportSpecifiers } from "../src/utils/import-graph.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string | Uint8Array): void {
  const filePath = join(root, path);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
}

describe("import graph", () => {
  test("parses import, export-from, require, and dynamic import specifiers", () => {
    const refs = parseImportSpecifiers(`
      import fs from "node:fs";
      import { a } from "./a";
      export { b } from "./b.js";
      const c = require("./c");
      const d = await import("./d.ts");
    `);

    expect(refs.map((ref) => ref.specifier)).toEqual(["node:fs", "./a", "./b.js", "./c", "./d.ts"]);
  });

  test("builds a lightweight directed import graph", () => {
    const dir = tempDir("coreline-graph-");
    try {
      write(dir, "src/a.ts", `import { b } from "./b"; export const a = b;`);
      write(dir, "src/b.ts", `export const b = 1;`);

      const graph = buildImportGraph(["src/a.ts", "src/b.ts"], { cwd: dir });
      expect(graph.nodes.get("src/a.ts")?.imports).toEqual(["src/b.ts"]);
      expect(graph.nodes.get("src/b.ts")?.importedBy).toEqual(["src/a.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context collector", () => {
  test("extracts path and symbol hints from prompt", () => {
    expect(extractPathHints("Check `src/agent/context-collector.ts` and ./tests/foo.test.ts"))
      .toEqual(["src/agent/context-collector.ts", "tests/foo.test.ts"]);
    expect(extractSymbolHints("Review ContextCollector and `collectContextCandidates`"))
      .toContain("ContextCollector");
  });

  test("returns top candidates from mentioned files, import neighbors, and symbols", () => {
    const dir = tempDir("coreline-context-");
    try {
      write(dir, "src/main.ts", `import { helper } from "./helper"; export function runMain() { return helper(); }`);
      write(dir, "src/helper.ts", `export function helper() { return "ok"; }`);
      write(dir, "src/other.ts", `export const OtherSymbol = true;`);

      const result = collectContextCandidates({
        cwd: dir,
        prompt: "Please update src/main.ts and inspect helper plus OtherSymbol",
        maxCandidates: 5,
      });

      expect(result.candidates[0]?.path).toBe("src/main.ts");
      expect(result.candidates.map((candidate) => candidate.path)).toContain("src/helper.ts");
      expect(result.candidates.map((candidate) => candidate.path)).toContain("src/other.ts");
      expect(result.candidates.find((candidate) => candidate.path === "src/helper.ts")?.reasons)
        .toContain("imports-mentioned-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes binary, oversized, and secret-like files without attaching content", () => {
    const dir = tempDir("coreline-context-exclude-");
    try {
      write(dir, "src/app.ts", `export const AppSecret = true;`);
      write(dir, "src/blob.ts", new Uint8Array([0, 1, 2, 3]));
      write(dir, "src/large.ts", "x".repeat(128));
      write(dir, ".env", "TOKEN=secret");

      const result = collectContextCandidates({
        cwd: dir,
        prompt: "Check src/blob.ts src/large.ts .env and AppSecret",
        maxFileSizeBytes: 64,
        includeExtensions: [".ts", ""],
      });

      expect(result.candidates.map((candidate) => candidate.path)).toContain("src/app.ts");
      expect(result.excluded).toContainEqual(expect.objectContaining({ path: "src/blob.ts", reason: "binary" }));
      expect(result.excluded).toContainEqual(expect.objectContaining({ path: "src/large.ts", reason: "oversized" }));
      expect(result.excluded).toContainEqual(expect.objectContaining({ path: ".env", reason: "secret-like" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
