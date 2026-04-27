/**
 * Configuration schemas — Zod validation for providers.yml and permissions.yml.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider Config Schema
// ---------------------------------------------------------------------------

export const providerTypeSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "openai-compatible",
  "codex-backend",
  "gemini-code-assist",
  "claude-cli",
  "gemini-cli",
  "codex-cli",
]);

export const providerConfigSchema = z.object({
  name: z.string().min(1),
  type: providerTypeSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  oauthToken: z.string().optional(),
  oauthFile: z.string().optional(),
  model: z.string().min(1),
  maxContextTokens: z.number().int().positive().optional(),
  planning: z.boolean().optional(),
  // Gemini Code Assist specific
  geminiProject: z.string().optional(),
});

export const providerOverrideSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export const providersFileSchema = z.object({
  default: z.string().min(1).optional(),
  providers: z.record(
    z.string(),
    providerConfigSchema.omit({ name: true }),
  ),
});

export type ProvidersFile = z.infer<typeof providersFileSchema>;
export type ProviderOverrideInput = z.infer<typeof providerOverrideSchema>;

// ---------------------------------------------------------------------------
// Permission Config Schema
// ---------------------------------------------------------------------------

export const permissionBehaviorSchema = z.enum(["allow", "deny", "ask"]);

export const permissionRuleSchema = z.object({
  behavior: permissionBehaviorSchema,
  toolName: z.string().min(1),
  pattern: z.string().optional(),
});

export const permissionModeSchema = z.enum(["default", "acceptAll", "denyAll"]);

export const permissionsFileSchema = z.object({
  mode: permissionModeSchema.default("default"),
  rules: z.array(permissionRuleSchema).default([]),
});

export type PermissionsFile = z.infer<typeof permissionsFileSchema>;

// ---------------------------------------------------------------------------
// Role Config Schema
// ---------------------------------------------------------------------------

export const roleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string().min(1),
});

export const rolesFileSchema = z.union([
  z.array(roleSchema).min(1),
  z.object({
    roles: z.array(roleSchema).min(1),
  }),
]);

export type RoleConfig = z.infer<typeof roleSchema>;
export type RolesFile = z.infer<typeof rolesFileSchema>;

// ---------------------------------------------------------------------------
// App Settings Schema
// ---------------------------------------------------------------------------

export const settingsThemeSchema = z.enum([
  "default",
  "dracula",
  "catppuccin-mocha",
  "catppuccin-latte",
  "gruvbox",
  "solarized-dark",
  "vitesse-dark",
  "github-dark",
  "atom-one-dark",
  "tomorrow-night",
]);
export type SettingsTheme = z.infer<typeof settingsThemeSchema>;
export const modelPricingOverrideSchema = z.object({
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
});

export const settingsFileSchema = z.object({
  defaultProvider: z.string().min(1).optional(),
  theme: settingsThemeSchema.default("default"),
  maxTurns: z.number().int().positive().default(50),
  pricing: z.record(modelPricingOverrideSchema).default({}),
});

export type SettingsFile = z.infer<typeof settingsFileSchema>;

// ---------------------------------------------------------------------------
// Helpers: parse providers file into ProviderConfig[]
// ---------------------------------------------------------------------------

import type { ProviderConfig } from "../providers/types.js";

export function parseProvidersFile(data: unknown): {
  configs: ProviderConfig[];
  defaultName?: string;
} {
  const parsed = providersFileSchema.parse(data);
  const configs: ProviderConfig[] = [];

  for (const [name, provider] of Object.entries(parsed.providers)) {
    configs.push({ name, ...provider });

    // M9: Warn if apiKey is missing for providers that typically need it
    if (provider.type !== "openai-compatible" && !provider.apiKey) {
      const envVarMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: "GOOGLE_API_KEY",
      };
      const envVar = envVarMap[provider.type];
      if (envVar && !process.env[envVar]) {
        console.warn(`[config] Provider "${name}" has no apiKey and ${envVar} is not set — will fail at runtime`);
      }
    }
  }

  return { configs, defaultName: parsed.default };
}
