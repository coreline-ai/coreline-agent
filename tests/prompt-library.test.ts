import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deletePrompt,
  listPrompts,
  loadPrompts,
  savePrompt,
  searchPrompts,
  type PromptSnippet,
} from "../src/prompt/library.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("prompt library", () => {
  test("saves, loads, lists, searches, and deletes prompt snippets", () => {
    const dir = tempDir("coreline-prompts-");
    try {
      expect(loadPrompts({ dir })).toEqual([]);

      const first = savePrompt({ name: "Reviewer note", text: "Check bugs first." }, { dir });
      const second = savePrompt({ name: "Planner note", text: "Split work into phases." }, { dir });

      expect(first.id).toMatch(/^[a-f0-9-]+$/);
      expect(second.createdAt >= first.createdAt).toBe(true);

      const all = listPrompts({ dir });
      expect(all.map((prompt) => prompt.name)).toEqual(["Planner note", "Reviewer note"]);

      const searchByName = searchPrompts("planner", { dir });
      expect(searchByName).toHaveLength(1);
      expect(searchByName[0]!.name).toBe("Planner note");

      const searchByText = searchPrompts("bugs", { dir });
      expect(searchByText).toHaveLength(1);
      expect(searchByText[0]!.text).toContain("bugs");

      expect(deletePrompt(first.id, { dir })).toBe(true);
      expect(deletePrompt(first.id, { dir })).toBe(false);
      expect(loadPrompts({ dir }).map((prompt) => prompt.id)).toEqual([second.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves an explicit id and createdAt when provided", () => {
    const dir = tempDir("coreline-prompts-explicit-");
    try {
      const prompt: PromptSnippet = savePrompt(
        {
          id: "custom-snippet",
          name: "Custom",
          text: "Keep this note.",
          createdAt: "2026-04-19T00:00:00.000Z",
        },
        { dir },
      );

      expect(prompt).toEqual({
        id: "custom-snippet",
        name: "Custom",
        text: "Keep this note.",
        createdAt: "2026-04-19T00:00:00.000Z",
      });
      expect(loadPrompts({ dir })[0]!).toEqual(prompt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid ids and empty fields", () => {
    const dir = tempDir("coreline-prompts-invalid-");
    try {
      expect(() =>
        savePrompt({ id: "bad/id", name: "Broken", text: "Nope" }, { dir }),
      ).toThrow();
      expect(() =>
        savePrompt({ name: "", text: "Nope" }, { dir }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

