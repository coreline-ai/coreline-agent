import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { paths } from "../src/config/paths.js";
import { getDefaultRoles, loadRoles, type Role } from "../src/config/roles.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("loadRoles", () => {
  test("returns the built-in preset roles when no file exists", () => {
    const dir = tempDir("coreline-roles-default-");
    const originalYml = paths.rolesYml;
    const originalJson = paths.rolesJson;

    try {
      (paths as { rolesYml: string; rolesJson: string }).rolesYml = join(dir, "roles.yml");
      (paths as { rolesYml: string; rolesJson: string }).rolesJson = join(dir, "roles.json");

      const roles = loadRoles();
      expect(roles.map((role) => role.id)).toEqual(["reviewer", "planner", "coder"]);
      expect(roles[0]!.instructions).toContain("correctness");
    } finally {
      (paths as { rolesYml: string; rolesJson: string }).rolesYml = originalYml;
      (paths as { rolesYml: string; rolesJson: string }).rolesJson = originalJson;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads roles from YAML and validates the shape", () => {
    const dir = tempDir("coreline-roles-yaml-");
    try {
      const filePath = join(dir, "roles.yml");
      writeFileSync(
        filePath,
        [
          "roles:",
          "  - id: reviewer",
          "    name: Reviewer",
          "    instructions: Review carefully.",
          "  - id: planner",
          "    name: Planner",
          "    instructions: Plan clearly.",
        ].join("\n"),
        "utf-8",
      );

      const roles = loadRoles({ filePath });
      expect(roles).toEqual([
        { id: "reviewer", name: "Reviewer", instructions: "Review carefully." },
        { id: "planner", name: "Planner", instructions: "Plan clearly." },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws a clear error for invalid role files", () => {
    const dir = tempDir("coreline-roles-invalid-");
    try {
      const filePath = join(dir, "roles.json");
      writeFileSync(filePath, JSON.stringify([{ id: "", name: "Broken", instructions: "" }]), "utf-8");

      expect(() => loadRoles({ filePath })).toThrow(/Invalid role config|Failed to load roles/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSystemPrompt role injection", () => {
  test("keeps the default prompt unchanged when no role is provided", () => {
    const base = buildSystemPrompt(process.cwd(), []);
    const legacy = buildSystemPrompt(process.cwd(), []);

    expect(base).toBe(legacy);
    expect(base).not.toContain("# Active Role");
  });

  test("adds an active role section when a role is provided", () => {
    const role: Role = {
      id: "reviewer",
      name: "Reviewer",
      instructions: "Focus on bugs and tests.",
    };

    const prompt = buildSystemPrompt(process.cwd(), [], undefined, undefined, role);

    expect(prompt).toContain("# Active Role");
    expect(prompt).toContain("- Id: reviewer");
    expect(prompt).toContain("- Name: Reviewer");
    expect(prompt).toContain("Focus on bugs and tests.");
  });
});

describe("getDefaultRoles", () => {
  test("returns a fresh copy of the built-in presets", () => {
    const roles = getDefaultRoles();
    roles[0]!.name = "Changed";

    expect(getDefaultRoles()[0]!.name).not.toBe("Changed");
  });
});
