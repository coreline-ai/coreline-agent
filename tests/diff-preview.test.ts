import { describe, expect, test } from "bun:test";
import { formatDiffSummary, generateUnifiedDiff } from "../src/agent/diff-preview.js";

describe("diff preview", () => {
  test("generates a unified diff for a single line change", () => {
    const preview = generateUnifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "src/example.ts");

    expect(preview.changed).toBe(true);
    expect(preview.added).toBe(1);
    expect(preview.removed).toBe(1);
    expect(preview.diff).toContain("--- a/src/example.ts");
    expect(preview.diff).toContain("+++ b/src/example.ts");
    expect(preview.diff).toContain("-two");
    expect(preview.diff).toContain("+TWO");
  });

  test("handles multiple additions and deletions", () => {
    const preview = generateUnifiedDiff("alpha\nbeta\ngamma\n", "alpha\ndelta\nepsilon\n", "notes.txt");

    expect(preview.added).toBe(2);
    expect(preview.removed).toBe(2);
    expect(preview.diff).toContain("-beta");
    expect(preview.diff).toContain("-gamma");
    expect(preview.diff).toContain("+delta");
    expect(preview.diff).toContain("+epsilon");
  });

  test("returns an explicit empty result when there are no changes", () => {
    const preview = generateUnifiedDiff("same\ncontent\n", "same\ncontent\n", "same.txt");

    expect(preview).toMatchObject({
      filePath: "same.txt",
      diff: "",
      added: 0,
      removed: 0,
      changed: false,
      truncated: false,
      omittedLines: 0,
    });
  });

  test("truncates large diffs with omitted line count", () => {
    const oldContent = Array.from({ length: 80 }, (_, index) => `old-${index}`).join("\n");
    const newContent = Array.from({ length: 80 }, (_, index) => `new-${index}`).join("\n");
    const preview = generateUnifiedDiff(oldContent, newContent, "large.txt", { maxLines: 10 });

    expect(preview.truncated).toBe(true);
    expect(preview.omittedLines).toBeGreaterThan(0);
    expect(preview.diff.split("\n")).toHaveLength(11);
    expect(preview.diff).toContain(`... (${preview.omittedLines} more lines)`);
  });

  test("formats summaries from preview, diff string, and old/new input", () => {
    const preview = generateUnifiedDiff("a\nb\n", "a\nc\nd\n", "summary.txt");

    expect(formatDiffSummary(preview).text).toBe("summary.txt: +2 -1");
    expect(formatDiffSummary(preview.diff)).toMatchObject({
      filePath: "summary.txt",
      added: 2,
      removed: 1,
      changed: true,
    });
    expect(
      formatDiffSummary({
        oldContent: "same\n",
        newContent: "same\n",
        filePath: "empty.txt",
      }).text,
    ).toBe("empty.txt: No changes");
  });
});
