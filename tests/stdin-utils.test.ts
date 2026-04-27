import { describe, expect, test } from "bun:test";
import { mergePromptAndStdin } from "../src/utils/stdin.js";

describe("mergePromptAndStdin", () => {
  test("returns prompt when stdin is empty", () => {
    expect(mergePromptAndStdin("review this", "")).toBe("review this");
    expect(mergePromptAndStdin("review this", null)).toBe("review this");
  });

  test("returns stdin when prompt is missing", () => {
    expect(mergePromptAndStdin(undefined, "const x = 1;")).toBe("const x = 1;");
  });

  test("combines prompt and stdin when both exist", () => {
    expect(mergePromptAndStdin("review this", "const x = 1;")).toBe(
      "review this\n\n[stdin]\nconst x = 1;",
    );
  });
});
