/**
 * Config paths — ~/.coreline-agent/ directory structure.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

const CONFIG_ROOT = join(homedir(), ".coreline-agent");

export const paths = {
  root: CONFIG_ROOT,
  configYml: join(CONFIG_ROOT, "config.yml"),
  providersYml: join(CONFIG_ROOT, "providers.yml"),
  permissionsYml: join(CONFIG_ROOT, "permissions.yml"),
  rolesYml: join(CONFIG_ROOT, "roles.yml"),
  rolesJson: join(CONFIG_ROOT, "roles.json"),
  systemPromptMd: join(CONFIG_ROOT, "system-prompt.md"),
  statusJson: join(CONFIG_ROOT, "status.json"),
  promptsDir: join(CONFIG_ROOT, "prompts"),
  sessionsDir: join(CONFIG_ROOT, "sessions"),
  backupsDir: join(CONFIG_ROOT, "backups"),
  projectsDir: join(CONFIG_ROOT, "projects"),
  userMemoryDir: join(CONFIG_ROOT, "user-memory"),
} as const;

/** Ensure config directories exist */
export function ensureConfigDirs(rootDir: string = CONFIG_ROOT): void {
  for (const dir of [rootDir, join(rootDir, "sessions"), join(rootDir, "backups"), join(rootDir, "projects"), join(rootDir, "prompts"), join(rootDir, "user-memory")]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/** Get the project directory for a project id/hash */
export function getProjectDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(rootDir, "projects", projectId);
}

/** Get the project memory directory for a project id/hash */
export function getProjectMemoryDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), "memory");
}

/** Ensure the project memory directory exists */
export function ensureProjectMemoryDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const dir = getProjectMemoryDir(projectId, rootDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// MemKraft integration dirs (Phase 0)
// ---------------------------------------------------------------------------

export function getSkillEvidenceDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), "skill-evidence");
}

export function ensureSkillEvidenceDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  const dir = getSkillEvidenceDir(projectId, rootDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSubagentEvidenceDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), "subagent-evidence");
}

export function ensureSubagentEvidenceDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  const dir = getSubagentEvidenceDir(projectId, rootDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getPromptEvidenceDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), "prompt-evidence");
}

export function ensurePromptEvidenceDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  const dir = getPromptEvidenceDir(projectId, rootDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSessionRecallDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), "session-recall");
}

export function ensureSessionRecallDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  const dir = getSessionRecallDir(projectId, rootDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the auto-generated MEMORY.md digest file. */
export function getDigestPath(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), "MEMORY.md");
}

// ---------------------------------------------------------------------------
// Wave 7-9 directories (MemKraft modules)
// ---------------------------------------------------------------------------

function _ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Bitemporal facts (Wave 7 Phase 1) — per-entity facts.md files. */
export function getFactsDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectMemoryDir(projectId, rootDir), "facts");
}
export function ensureFactsDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  return _ensureDir(getFactsDir(projectId, rootDir));
}

/** Decay tombstones (Wave 7 Phase 2) — soft-deleted entries restorable. */
export function getTombstonesDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectDir(projectId, rootDir), ".memory", "tombstones");
}
export function ensureTombstonesDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  return _ensureDir(getTombstonesDir(projectId, rootDir));
}

/** Wiki link index (Wave 7 Phase 3) — forward.json (backlinks Wave 10+). */
export function getLinksDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectMemoryDir(projectId, rootDir), "links");
}
export function ensureLinksDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  return _ensureDir(getLinksDir(projectId, rootDir));
}

/** Incidents (Wave 8) — incident records as memory entries. */
export function getIncidentsDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectMemoryDir(projectId, rootDir), "incidents");
}
export function ensureIncidentsDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  return _ensureDir(getIncidentsDir(projectId, rootDir));
}

/** Decisions (Wave 9 Phase 7) — decision records (What/Why/How). */
export function getDecisionsDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectMemoryDir(projectId, rootDir), "decisions");
}
export function ensureDecisionsDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  return _ensureDir(getDecisionsDir(projectId, rootDir));
}

/** Runbooks (Wave 9 Phase 8) — symptom→steps remediation patterns. */
export function getRunbooksDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  return join(getProjectMemoryDir(projectId, rootDir), "runbooks");
}
export function ensureRunbooksDir(projectId: string, rootDir: string = CONFIG_ROOT): string {
  if (!projectId) throw new Error("projectId is required");
  return _ensureDir(getRunbooksDir(projectId, rootDir));
}
