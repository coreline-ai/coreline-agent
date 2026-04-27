/**
 * Role presets — reusable execution profiles for the agent.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { paths } from "./paths.js";
import { rolesFileSchema, type RolesFile } from "./schema.js";
import type { ConfigLoadSnapshot } from "./diagnostics.js";

export interface Role {
  id: string;
  name: string;
  instructions: string;
}

const defaultRoles: Role[] = [
  {
    id: "reviewer",
    name: "Code Reviewer",
    instructions: [
      "Review the code carefully for correctness, bugs, regressions, edge cases, and test coverage.",
      "Prefer clear, actionable feedback and cite the most relevant files or lines when possible.",
      "Focus on issues that matter most to production behavior and maintainability.",
    ].join(" "),
  },
  {
    id: "planner",
    name: "Planner",
    instructions: [
      "Break work into small, dependency-aware steps that can be executed safely in parallel.",
      "Define scope boundaries clearly, keep the plan minimal, and call out prerequisites or risky overlap.",
      "Prefer concrete file-level actions over vague implementation ideas.",
    ].join(" "),
  },
  {
    id: "coder",
    name: "Coder",
    instructions: [
      "Implement the requested change directly and stay close to the existing codebase patterns.",
      "Read relevant files before editing, avoid unnecessary abstraction, and keep the patch focused.",
      "When a choice is ambiguous, prefer the smallest safe implementation that satisfies the request.",
    ].join(" "),
  },
];

export type RoleFileInput = RolesFile;

function cloneDefaultRoles(): Role[] {
  return defaultRoles.map((role) => ({ ...role }));
}

function normalizeRolesInput(data: RoleFileInput): Role[] {
  return Array.isArray(data) ? data : data.roles;
}

function parseRolesData(data: unknown, source: string): Role[] {
  const parsed = rolesFileSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "roles"}: ${issue.message}` : "invalid roles file";
    throw new Error(`Invalid role config in ${source}: ${detail}`);
  }

  return normalizeRolesInput(parsed.data);
}

function loadRolesFromFile(filePath: string): Role[] {
  const raw = readFileSync(filePath, "utf-8");
  const data = extname(filePath).toLowerCase() === ".json" ? JSON.parse(raw) : parseYaml(raw);
  return parseRolesData(data, filePath);
}

function loadRolesSnapshotFromFile(filePath: string): ConfigLoadSnapshot<Role[]> {
  try {
    const roles = loadRolesFromFile(filePath);
    return {
      filePath,
      status: "loaded",
      config: roles,
      sourcePath: filePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const issueKind = message.toLowerCase().includes("parse") || message.toLowerCase().includes("yaml")
      ? "parse-error"
      : "schema-error";
    return {
      filePath,
      status: "invalid",
      config: cloneDefaultRoles(),
      issue: {
        kind: issueKind,
        message: `Failed to load roles from ${filePath}`,
        detail: message,
      },
    };
  }
}

function resolveDefaultRolesFile(): string | undefined {
  if (existsSync(paths.rolesYml)) {
    return paths.rolesYml;
  }

  if (existsSync(paths.rolesJson)) {
    return paths.rolesJson;
  }

  return undefined;
}

export function loadRoles(options: { filePath?: string } = {}): Role[] {
  const filePath = options.filePath ?? resolveDefaultRolesFile();
  if (!filePath || !existsSync(filePath)) {
    return cloneDefaultRoles();
  }
  return loadRolesFromFile(filePath);
}

export function loadRolesWithStatus(options: { filePath?: string } = {}): ConfigLoadSnapshot<Role[]> {
  const filePath = options.filePath ?? resolveDefaultRolesFile();
  if (!filePath) {
    return {
      filePath: paths.rolesYml,
      status: "missing",
      config: cloneDefaultRoles(),
      issue: {
        kind: "missing-file",
        message: `Role config file not found: ${paths.rolesYml}`,
      },
    };
  }

  if (!existsSync(filePath)) {
    return {
      filePath,
      status: "missing",
      config: cloneDefaultRoles(),
      issue: {
        kind: "missing-file",
        message: `Role config file not found: ${filePath}`,
      },
    };
  }

  return loadRolesSnapshotFromFile(filePath);
}

export function getDefaultRoles(): Role[] {
  return cloneDefaultRoles();
}

export function findRole(roles: Role[], query: string): Role | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return roles.find((role) =>
    role.id.toLowerCase() === normalized || role.name.toLowerCase() === normalized
  ) ?? roles.find((role) =>
    role.id.toLowerCase().includes(normalized) || role.name.toLowerCase().includes(normalized)
  );
}

export function loadRole(query: string, options: { filePath?: string } = {}): Role | undefined {
  return findRole(loadRoles(options), query);
}
