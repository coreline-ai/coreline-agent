/**
 * Config loader — YAML loading with Zod validation + defaults.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureConfigDirs, paths } from "./paths.js";
import {
  parseProvidersFile,
  permissionsFileSchema,
  settingsFileSchema,
  type PermissionsFile,
  type ProvidersFile,
  type SettingsFile,
} from "./schema.js";
import type { ConfigLoadIssue, ConfigLoadSnapshot } from "./diagnostics.js";
import type { ProviderConfig } from "../providers/types.js";
import type { PermissionRule, PermissionMode } from "../permissions/types.js";

function writeYamlAtomically(filePath: string, data: unknown): void {
  ensureConfigDirs();
  const tempPath = join(dirname(filePath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tempPath, stringifyYaml(data), "utf-8");
  renameSync(tempPath, filePath);
}

function makeMissingIssue(filePath: string): ConfigLoadIssue {
  return {
    kind: "missing-file",
    message: `Config file not found: ${filePath}`,
  };
}

function makeParseIssue(filePath: string, error: unknown): ConfigLoadIssue {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "parse-error",
    message: `Failed to parse ${filePath}`,
    detail: message,
  };
}

function makeSchemaIssue(filePath: string, error: unknown): ConfigLoadIssue {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "schema-error",
    message: `Invalid config in ${filePath}`,
    detail: message,
  };
}

function loadYamlWithStatus<T>(opts: {
  filePath: string;
  emptyConfig: T;
  parse: (data: unknown, filePath: string) => T;
  schemaLabel: string;
}): ConfigLoadSnapshot<T> {
  const { filePath, emptyConfig, parse, schemaLabel } = opts;

  if (!existsSync(filePath)) {
    return {
      filePath,
      status: "missing",
      config: emptyConfig,
      issue: makeMissingIssue(filePath),
    };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    const config = parse(parsed, filePath);
    return {
      filePath,
      status: "loaded",
      config,
      sourcePath: filePath,
    };
  } catch (error) {
    const issue = error instanceof Error && error.name.toLowerCase().includes("parse")
      ? makeParseIssue(filePath, error)
      : makeSchemaIssue(filePath, error);

    console.error(`[config] Failed to load ${schemaLabel} from ${filePath}: ${issue.detail ?? issue.message}`);
    return {
      filePath,
      status: "invalid",
      config: emptyConfig,
      issue,
    };
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function loadProviders(): { configs: ProviderConfig[]; defaultName?: string } {
  return loadProvidersWithStatus().config;
}

export function loadProvidersWithStatus(): ConfigLoadSnapshot<{ configs: ProviderConfig[]; defaultName?: string }> {
  return loadYamlWithStatus({
    filePath: paths.providersYml,
    emptyConfig: { configs: [] },
    schemaLabel: "providers.yml",
    parse: (data) => parseProvidersFile(data),
  });
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export function loadPermissions(): { mode: PermissionMode; rules: PermissionRule[] } {
  return loadPermissionsWithStatus().config;
}

export function loadPermissionsWithStatus(): ConfigLoadSnapshot<{ mode: PermissionMode; rules: PermissionRule[] }> {
  return loadYamlWithStatus({
    filePath: paths.permissionsYml,
    emptyConfig: { mode: "default", rules: [] },
    schemaLabel: "permissions.yml",
    parse: (data) => {
      const parsed: PermissionsFile = permissionsFileSchema.parse(data);
      return { mode: parsed.mode, rules: parsed.rules };
    },
  });
}

export function saveProviders(data: ProvidersFile): void {
  writeYamlAtomically(paths.providersYml, data);
}

export function savePermissions(data: PermissionsFile): void {
  writeYamlAtomically(paths.permissionsYml, data);
}

export function loadSettings(): SettingsFile {
  return loadSettingsWithStatus().config;
}

export function loadSettingsWithStatus(): ConfigLoadSnapshot<SettingsFile> {
  return loadYamlWithStatus({
    filePath: paths.configYml,
    emptyConfig: settingsFileSchema.parse({}),
    schemaLabel: "config.yml",
    parse: (data) => settingsFileSchema.parse(data),
  });
}

export function saveSettings(data: SettingsFile): void {
  writeYamlAtomically(paths.configYml, settingsFileSchema.parse(data));
}

export function resolveDefaultProviderName(opts: {
  cliProvider?: string;
  settingsDefaultProvider?: string;
  providersDefaultName?: string;
}): string | undefined {
  return opts.cliProvider ?? opts.settingsDefaultProvider ?? opts.providersDefaultName;
}

export function resolveMaxTurns(opts: {
  cliMaxTurns?: string;
  settingsMaxTurns: number;
}): number {
  if (!opts.cliMaxTurns) {
    return opts.settingsMaxTurns;
  }

  const parsed = Number.parseInt(opts.cliMaxTurns, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return opts.settingsMaxTurns;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// System Prompt Customization
// ---------------------------------------------------------------------------

export function loadCustomSystemPrompt(): string | null {
  if (!existsSync(paths.systemPromptMd)) {
    return null;
  }

  try {
    return readFileSync(paths.systemPromptMd, "utf-8").trim();
  } catch {
    return null;
  }
}
