/**
 * Config diagnostics tests — status, issues, and provenance.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPermissionsWithStatus, loadProvidersWithStatus, loadSettingsWithStatus } from "../src/config/loader.js";
import { loadRolesWithStatus } from "../src/config/roles.js";
import { paths } from "../src/config/paths.js";

describe("config diagnostics", () => {
  let tmpDir: string;
  let originalPaths: {
    configYml: string;
    providersYml: string;
    permissionsYml: string;
    rolesYml: string;
    rolesJson: string;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-config-diag-"));
    originalPaths = {
      configYml: paths.configYml,
      providersYml: paths.providersYml,
      permissionsYml: paths.permissionsYml,
      rolesYml: paths.rolesYml,
      rolesJson: paths.rolesJson,
    };

    (paths as typeof paths & Record<string, string>).configYml = join(tmpDir, "config.yml");
    (paths as typeof paths & Record<string, string>).providersYml = join(tmpDir, "providers.yml");
    (paths as typeof paths & Record<string, string>).permissionsYml = join(tmpDir, "permissions.yml");
    (paths as typeof paths & Record<string, string>).rolesYml = join(tmpDir, "roles.yml");
    (paths as typeof paths & Record<string, string>).rolesJson = join(tmpDir, "roles.json");
  });

  afterEach(() => {
    (paths as typeof paths & Record<string, string>).configYml = originalPaths.configYml;
    (paths as typeof paths & Record<string, string>).providersYml = originalPaths.providersYml;
    (paths as typeof paths & Record<string, string>).permissionsYml = originalPaths.permissionsYml;
    (paths as typeof paths & Record<string, string>).rolesYml = originalPaths.rolesYml;
    (paths as typeof paths & Record<string, string>).rolesJson = originalPaths.rolesJson;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("missing config files return missing status with default configs", () => {
    const settings = loadSettingsWithStatus();
    const providers = loadProvidersWithStatus();
    const permissions = loadPermissionsWithStatus();
    const roles = loadRolesWithStatus();

    expect(settings.status).toBe("missing");
    expect(settings.issue?.kind).toBe("missing-file");
    expect(settings.config).toMatchObject({ theme: "default", maxTurns: 50 });

    expect(providers.status).toBe("missing");
    expect(providers.issue?.kind).toBe("missing-file");
    expect(providers.config).toEqual({ configs: [] });

    expect(permissions.status).toBe("missing");
    expect(permissions.issue?.kind).toBe("missing-file");
    expect(permissions.config).toEqual({ mode: "default", rules: [] });

    expect(roles.status).toBe("missing");
    expect(roles.issue?.kind).toBe("missing-file");
    expect(roles.config).toHaveLength(3);
  });

  test("invalid YAML is reported as parse error", () => {
    writeFileSync(paths.configYml, "theme: [broken", "utf-8");

    const result = loadSettingsWithStatus();

    expect(result.status).toBe("invalid");
    expect(result.issue?.kind).toBe("parse-error");
    expect(result.config).toMatchObject({ theme: "default", maxTurns: 50 });
  });

  test("schema validation failure is reported as schema error", () => {
    writeFileSync(
      paths.providersYml,
      [
        "providers:",
        "  bad:",
        "    type: anthropic",
        "    model: ''",
      ].join("\n"),
      "utf-8",
    );

    const result = loadProvidersWithStatus();

    expect(result.status).toBe("invalid");
    expect(result.issue?.kind).toBe("schema-error");
    expect(result.config).toEqual({ configs: [] });
  });

  test("loaded configs preserve source path provenance", () => {
    writeFileSync(
      paths.configYml,
      [
        "defaultProvider: local",
        "theme: dark",
        "maxTurns: 25",
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      paths.permissionsYml,
      [
        "mode: default",
        "rules:",
        "  - behavior: allow",
        "    toolName: Bash",
        "    pattern: npm test",
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      paths.rolesYml,
      [
        "roles:",
        "  - id: reviewer",
        "    name: Reviewer",
        "    instructions: Review carefully.",
      ].join("\n"),
      "utf-8",
    );

    const settings = loadSettingsWithStatus();
    const permissions = loadPermissionsWithStatus();
    const roles = loadRolesWithStatus();

    expect(settings.status).toBe("loaded");
    expect(settings.sourcePath).toBe(paths.configYml);
    expect(settings.config).toMatchObject({
      defaultProvider: "local",
      theme: "dark",
      maxTurns: 25,
    });

    expect(permissions.status).toBe("loaded");
    expect(permissions.sourcePath).toBe(paths.permissionsYml);
    expect(permissions.config).toEqual({
      mode: "default",
      rules: [{ behavior: "allow", toolName: "Bash", pattern: "npm test" }],
    });

    expect(roles.status).toBe("loaded");
    expect(roles.sourcePath).toBe(paths.rolesYml);
    expect(roles.config).toEqual([
      { id: "reviewer", name: "Reviewer", instructions: "Review carefully." },
    ]);
  });

  test("roles schema validation failure falls back to defaults with invalid status", () => {
    writeFileSync(
      paths.rolesJson,
      JSON.stringify([{ id: "", name: "Broken", instructions: "" }]),
      "utf-8",
    );

    const result = loadRolesWithStatus({ filePath: paths.rolesJson });

    expect(result.status).toBe("invalid");
    expect(result.issue?.kind).toBe("schema-error");
    expect(result.config.map((role) => role.id)).toEqual(["reviewer", "planner", "coder"]);
  });
});

