import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildScaffoldPlan,
  generateScaffold,
  normalizeScaffoldName,
  type ScaffoldKind,
  ScaffoldError,
} from "../src/scaffold/index.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("scaffold core", () => {
  test("normalizes names into safe casing variants", () => {
    const name = normalizeScaffoldName("HTTP client");
    expect(name).toEqual({
      input: "HTTP client",
      normalized: "http-client",
      kebab: "http-client",
      camel: "httpClient",
      pascal: "HttpClient",
      words: ["HTTP", "client"],
    });
  });

  test.each<ScaffoldKind>(["tool", "provider", "test", "slash-command", "hook"])(
    "builds a preview plan for %s scaffolds",
    (kind) => {
      const root = tempRoot("coreline-scaffold-preview-");
      try {
        const plan = buildScaffoldPlan({ rootDir: root, kind, name: "HTTP client" });
        expect(plan.rootDir).toBe(resolve(root));
        expect(plan.kind).toBe(kind);
        expect(plan.name.kebab).toBe("http-client");
        expect(plan.files.length).toBeGreaterThan(0);
        for (const file of plan.files) {
          expect(file.relativePath).not.toContain("..");
          expect(file.absolutePath.startsWith(resolve(root))).toBe(true);
        }

        const relativePaths = plan.files.map((file) => file.relativePath);
        if (kind === "tool") {
          expect(relativePaths).toContain("src/tools/http-client/http-client-tool.ts");
          expect(plan.files[0]!.content).toContain("HttpClientTool");
        } else if (kind === "provider") {
          expect(relativePaths).toContain("src/providers/http-client.ts");
          expect(plan.files[0]!.content).toContain("createHttpClientProvider");
        } else if (kind === "test") {
          expect(relativePaths).toEqual(["tests/http-client.test.ts"]);
        } else if (kind === "slash-command") {
          expect(relativePaths).toContain("src/tui/scaffold/http-client.ts");
          expect(plan.notes.join(" ")).toContain("src/tui/slash-commands.ts");
        } else {
          expect(relativePaths).toContain("src/hooks/http-client.ts");
          expect(plan.files[0]!.content).toContain("HttpClientHook");
        }
      } finally {
        cleanup(root);
      }
    },
  );

  test("writes scaffold files to a temp root and refuses overwrite", async () => {
    const root = tempRoot("coreline-scaffold-write-");
    try {
      const result = await generateScaffold({
        rootDir: root,
        kind: "tool",
        name: "sample logger",
      });

      expect(result.dryRun).toBe(false);
      expect(result.createdFiles).toHaveLength(2);
      for (const file of result.createdFiles) {
        expect(existsSync(file)).toBe(true);
        expect(file.startsWith(resolve(root))).toBe(true);
      }

      const toolFile = join(root, "src/tools/sample-logger/sample-logger-tool.ts");
      expect(readFileSync(toolFile, "utf-8")).toContain("SampleLoggerTool");

      await expect(
        generateScaffold({
          rootDir: root,
          kind: "tool",
          name: "sample logger",
        }),
      ).rejects.toBeInstanceOf(ScaffoldError);
    } finally {
      cleanup(root);
    }
  });

  test("supports dry runs without touching disk", async () => {
    const root = tempRoot("coreline-scaffold-dry-run-");
    try {
      const result = await generateScaffold({
        rootDir: root,
        kind: "provider",
        name: "core api",
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.createdFiles).toEqual([]);
      expect(existsSync(join(root, "src/providers/core-api.ts"))).toBe(false);
      expect(result.plan.files[0]!.relativePath).toBe("src/providers/core-api.ts");
    } finally {
      cleanup(root);
    }
  });

  test("rejects path traversal and invalid names", () => {
    const root = tempRoot("coreline-scaffold-invalid-");
    try {
      expect(() =>
        buildScaffoldPlan({ rootDir: root, kind: "hook", name: "../escape" }),
      ).toThrow(ScaffoldError);
      expect(() =>
        buildScaffoldPlan({ rootDir: root, kind: "hook", name: "   " }),
      ).toThrow(ScaffoldError);
      expect(() =>
        buildScaffoldPlan({ rootDir: root, kind: "hook", name: "name/with/slash" }),
      ).toThrow(ScaffoldError);
      expect(() =>
        buildScaffoldPlan({ rootDir: root, kind: "bogus" as never, name: "demo" }),
      ).toThrow(ScaffoldError);
    } finally {
      cleanup(root);
    }
  });
});
