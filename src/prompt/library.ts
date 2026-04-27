/**
 * Prompt library — file-backed reusable prompt snippets.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { paths } from "../config/paths.js";
import type { MemoryTier } from "../memory/types.js";
import { appendEvidence, readEvidence } from "../agent/self-improve/evidence.js";
import type { EvidenceOutcome } from "../agent/self-improve/types.js";

export interface PromptSnippet {
  id: string;
  name: string;
  text: string;
  createdAt: string;
  // Phase 9 (A2) — optional metadata fields, backward compatible.
  tier?: MemoryTier;
  owner?: string;
  tags?: string[];
  criticalRequirements?: string[];
  /** ISO timestamp. Presence signals the snippet was registered with metadata. */
  registeredAt?: string;
}

const memoryTierSchema = z.enum(["core", "recall", "archival"]);

const promptSnippetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.string().min(1),
  tier: memoryTierSchema.optional(),
  owner: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  criticalRequirements: z.array(z.string().min(1)).optional(),
  registeredAt: z.string().min(1).optional(),
});

const promptSnippetInputSchema = promptSnippetSchema
  .omit({ createdAt: true })
  .extend({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
    createdAt: z.string().min(1).optional(),
  });

export interface RegisterPromptWithMetadataParams {
  name: string;
  text: string;
  owner?: string;
  tier?: MemoryTier;
  tags?: string[];
  criticalRequirements?: string[];
  id?: string;
  dir?: string;
}

export interface RecordPromptUseParams {
  projectId: string;
  promptName: string;
  sessionId: string;
  outcome: EvidenceOutcome;
  metadata?: Record<string, unknown>;
  /** Override config root — primarily for tests. */
  rootDir?: string;
}

function resolvePromptsDir(dir?: string): string {
  return dir ?? paths.promptsDir;
}

function ensurePromptsDir(dir?: string): string {
  const resolved = resolvePromptsDir(dir);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function promptFilePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function writeJsonAtomically(filePath: string, data: unknown): void {
  const tempPath = join(dirname(filePath), `.${Date.now()}-${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tempPath, filePath);
}

function readSnippetFile(filePath: string): PromptSnippet {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const result = promptSnippetSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "snippet"}: ${issue.message}` : "invalid prompt snippet";
    throw new Error(`Invalid prompt snippet in ${filePath}: ${detail}`);
  }

  return result.data;
}

function sortPrompts(prompts: PromptSnippet[]): PromptSnippet[] {
  return [...prompts].sort((a, b) => {
    const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return a.name.localeCompare(b.name);
  });
}

export function loadPrompts(options: { dir?: string } = {}): PromptSnippet[] {
  const dir = resolvePromptsDir(options.dir);
  if (!existsSync(dir)) {
    return [];
  }

  const snippets: PromptSnippet[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const snippet = readSnippetFile(join(dir, entry.name));
      snippets.push(snippet);
    } catch {
      // TC-9.E1: skip corrupt prompt files instead of crashing the library.
      continue;
    }
  }

  return sortPrompts(snippets);
}

export const listPrompts = loadPrompts;

export function savePrompt(
  prompt: {
    name: string;
    text: string;
    id?: string;
    createdAt?: string;
    tier?: MemoryTier;
    owner?: string;
    tags?: string[];
    criticalRequirements?: string[];
    registeredAt?: string;
  },
  options: { dir?: string } = {},
): PromptSnippet {
  const parsed = promptSnippetInputSchema.parse(prompt);
  const snippet: PromptSnippet = {
    id: parsed.id ?? randomUUID(),
    name: parsed.name,
    text: parsed.text,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    ...(parsed.tier !== undefined ? { tier: parsed.tier } : {}),
    ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
    ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
    ...(parsed.criticalRequirements !== undefined
      ? { criticalRequirements: parsed.criticalRequirements }
      : {}),
    ...(parsed.registeredAt !== undefined ? { registeredAt: parsed.registeredAt } : {}),
  };

  const dir = ensurePromptsDir(options.dir);
  writeJsonAtomically(promptFilePath(dir, snippet.id), snippet);
  return snippet;
}

/**
 * Phase 9 (A2) — Register a prompt snippet with MemKraft-style metadata.
 *
 * Thin wrapper around `savePrompt` that also sets `tier`, `owner`, `tags`,
 * `criticalRequirements`, and stamps `registeredAt`. Downstream callers can
 * distinguish metadata-enabled snippets by presence of `registeredAt`.
 */
export function registerPromptWithMetadata(
  params: RegisterPromptWithMetadataParams,
): PromptSnippet {
  const now = new Date().toISOString();
  return savePrompt(
    {
      id: params.id,
      name: params.name,
      text: params.text,
      tier: params.tier,
      owner: params.owner,
      tags: params.tags,
      criticalRequirements: params.criticalRequirements,
      registeredAt: now,
    },
    { dir: params.dir },
  );
}

/**
 * Phase 9 (A2) — Record a prompt invocation as append-only evidence.
 *
 * Best-effort: all errors are swallowed. Computes the next iteration from
 * existing evidence history for (domain="prompt", id=promptName).
 * The caller is responsible for deciding whether to record (e.g. skip when
 * the prompt has no `registeredAt` metadata).
 */
export function recordPromptUse(params: RecordPromptUseParams): void {
  try {
    const prior = readEvidence(
      params.projectId,
      "prompt",
      params.promptName,
      {},
      params.rootDir,
    );
    const iteration = prior.length + 1;
    appendEvidence(
      params.projectId,
      {
        domain: "prompt",
        id: params.promptName,
        sessionId: params.sessionId,
        iteration,
        invokedAt: new Date().toISOString(),
        outcome: params.outcome,
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
      params.rootDir,
    );
  } catch {
    // best-effort: never throw on evidence write failure.
  }
}

export function deletePrompt(id: string, options: { dir?: string } = {}): boolean {
  if (!id.trim()) {
    throw new Error("Prompt id is required");
  }

  const dir = resolvePromptsDir(options.dir);
  const filePath = promptFilePath(dir, id);
  if (!existsSync(filePath)) {
    return false;
  }

  rmSync(filePath);
  return true;
}

export function searchPrompts(query: string, options: { dir?: string } = {}): PromptSnippet[] {
  const normalized = query.trim().toLowerCase();
  const prompts = loadPrompts(options);
  if (!normalized) {
    return prompts;
  }

  return prompts.filter((prompt) => {
    const haystack = `${prompt.id}\n${prompt.name}\n${prompt.text}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function findPrompt(query: string, options: { dir?: string } = {}): PromptSnippet | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const prompts = loadPrompts(options);
  return prompts.find((prompt) =>
    prompt.id.toLowerCase() === normalized || prompt.name.toLowerCase() === normalized
  ) ?? prompts.find((prompt) =>
    prompt.id.toLowerCase().includes(normalized) || prompt.name.toLowerCase().includes(normalized)
  );
}
