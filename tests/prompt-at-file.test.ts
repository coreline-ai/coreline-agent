import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expandAtFilePrompt,
  formatAtFileIssues,
  parseAtFileTokens,
  prepareUserPrompt,
  summarizePromptForDisplay,
} from "../src/prompt/index.js";

describe("parseAtFileTokens", () => {
  test("finds attachment tokens and strips punctuation", () => {
    const tokens = parseAtFileTokens("Review @src/index.ts, @README.md.");

    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.rawPath).toBe("src/index.ts");
    expect(tokens[0]!.isGlob).toBe(false);
    expect(tokens[1]!.rawPath).toBe("README.md");
  });

  test("supports tokens wrapped in punctuation", () => {
    const tokens = parseAtFileTokens("Look at (@src/app.ts)");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.rawPath).toBe("src/app.ts");
  });
});

describe("expandAtFilePrompt", () => {
  test("expands a single file and removes token text from the prompt", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-"));
    try {
      writeFileSync(join(root, "notes.md"), "hello from notes");

      const result = expandAtFilePrompt("Please inspect @notes.md", { cwd: root });

      expect(result.text).toBe("Please inspect");
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]!.displayPath).toBe("notes.md");
      expect(result.attachments[0]!.content).toBe("hello from notes");
      expect(result.issues).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deduplicates repeated references to the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-dup-"));
    try {
      writeFileSync(join(root, "shared.txt"), "same content");

      const result = expandAtFilePrompt("Check @shared.txt and again @shared.txt", { cwd: root });

      expect(result.attachments).toHaveLength(1);
      expect(result.issues.some((issue) => issue.kind === "duplicate")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expands glob patterns into multiple files", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-glob-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
      writeFileSync(join(root, "src", "b.ts"), "export const b = 2;");

      const result = expandAtFilePrompt("Read @src/*.ts", { cwd: root });

      expect(result.attachments.map((item) => item.displayPath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.issues).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports missing, binary, and oversized files", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-errors-"));
    try {
      writeFileSync(join(root, "small.txt"), "ok");
      writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 4]));
      writeFileSync(join(root, "big.txt"), "x".repeat(1024));

      const result = expandAtFilePrompt("A @small.txt B @missing.txt C @binary.bin D @big.txt", {
        cwd: root,
        maxBytesPerFile: 8,
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]!.displayPath).toBe("small.txt");
      expect(result.issues.map((issue) => issue.kind)).toContain("missing");
      expect(result.issues.map((issue) => issue.kind)).toContain("binary");
      expect(result.issues.map((issue) => issue.kind)).toContain("too_large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports directory and glob-miss cases", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-dir-"));
    try {
      mkdirSync(join(root, "folder"));

      const result = expandAtFilePrompt("A @folder B @nope/*.ts", { cwd: root });

      expect(result.attachments).toHaveLength(0);
      expect(result.issues.map((issue) => issue.kind)).toContain("not_a_file");
      expect(result.issues.map((issue) => issue.kind)).toContain("glob_no_matches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareUserPrompt", () => {
  test("renders attachments into message text and compact display text", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-prepare-"));
    try {
      writeFileSync(join(root, "notes.md"), "hello from notes");

      const result = prepareUserPrompt("Please inspect @notes.md", { cwd: root });

      expect(result.messageText).toContain("<coreline-attached-files>");
      expect(result.messageText).toContain("--- FILE: notes.md (16 bytes) ---");
      expect(result.messageText).toContain("hello from notes");
      expect(result.displayText).toBe("Please inspect\n[Attached: notes.md]");
      expect(result.issues).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports attachment-only prompts and summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "coreline-at-file-only-"));
    try {
      writeFileSync(join(root, "notes.md"), "hello from notes");

      const result = prepareUserPrompt("@notes.md", { cwd: root });

      expect(result.displayText).toBe("[Attached: notes.md]");
      expect(summarizePromptForDisplay(result.messageText)).toBe("[Attached: notes.md]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatAtFileIssues", () => {
  test("renders a readable attachment warning block", () => {
    const result = formatAtFileIssues([
      { sourceToken: "@missing.txt", rawPath: "missing.txt", kind: "missing", message: "File not found: @missing.txt" },
      { sourceToken: "@binary.bin", rawPath: "binary.bin", kind: "binary", message: "Binary file skipped: @binary.bin" },
    ]);

    expect(result).toContain("Attachment issues:");
    expect(result).toContain("File not found: @missing.txt");
    expect(result).toContain("Binary file skipped: @binary.bin");
  });
});
