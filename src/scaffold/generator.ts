/**
 * Scaffold generator.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ScaffoldExecutionResult,
  ScaffoldKind,
  ScaffoldNameParts,
  ScaffoldPlan,
  ScaffoldRequest,
  ScaffoldRenderedFileSpec,
} from "./types.js";
import { ScaffoldError } from "./types.js";
import { getScaffoldTemplate, renderScaffoldFiles } from "./templates.js";

function assertRootDir(rootDir: string): string {
  const trimmed = rootDir.trim();
  if (!trimmed) {
    throw new ScaffoldError("invalid-root", "Scaffold root is required");
  }

  return resolve(trimmed);
}

function assertScaffoldKind(kind: string): ScaffoldKind {
  if (kind === "tool" || kind === "provider" || kind === "test" || kind === "slash-command" || kind === "hook") {
    return kind;
  }

  throw new ScaffoldError("invalid-kind", `Unsupported scaffold kind: ${kind}`);
}

function splitIntoWords(input: string): string[] {
  const withBoundaries = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\s]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();

  if (!withBoundaries) {
    return [];
  }

  return withBoundaries.split(/\s+/).filter(Boolean);
}

function wordsToKebab(words: string[]): string {
  return words.map((word) => word.toLowerCase()).join("-");
}

function wordsToCamel(words: string[]): string {
  if (words.length === 0) return "";
  const [first, ...rest] = words;
  return [
    first.toLowerCase(),
    ...rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()),
  ].join("");
}

function wordsToPascal(words: string[]): string {
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export function normalizeScaffoldName(input: string): ScaffoldNameParts {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ScaffoldError("invalid-name", "Scaffold name is required");
  }

  if (/[/\\]/.test(trimmed) || trimmed.includes("..") || /\0/.test(trimmed)) {
    throw new ScaffoldError("path-traversal", `Refusing unsafe scaffold name: ${input}`);
  }

  const words = splitIntoWords(trimmed);
  if (words.length === 0) {
    throw new ScaffoldError("invalid-name", `Scaffold name is invalid: ${input}`);
  }

  const kebab = wordsToKebab(words);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(kebab)) {
    throw new ScaffoldError("invalid-name", `Scaffold name must normalize to a safe slug: ${input}`);
  }

  return {
    input: trimmed,
    normalized: kebab,
    kebab,
    camel: wordsToCamel(words),
    pascal: wordsToPascal(words),
    words,
  };
}

function resolveRelativeWithinRoot(rootDir: string, relativePath: string): string {
  const absoluteRoot = assertRootDir(rootDir);
  const normalizedRelative = relativePath.replace(/\\/g, "/");

  if (
    !normalizedRelative ||
    isAbsolute(normalizedRelative) ||
    normalizedRelative.startsWith("../") ||
    normalizedRelative.includes("/../") ||
    normalizedRelative.endsWith("/..") ||
    normalizedRelative.includes("\0") ||
    normalizedRelative.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new ScaffoldError("path-traversal", `Refusing to write outside scaffold root: ${relativePath}`);
  }

  const absoluteTarget = resolve(absoluteRoot, normalizedRelative);
  const relativeTarget = relative(absoluteRoot, absoluteTarget);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new ScaffoldError("path-traversal", `Refusing to write outside scaffold root: ${relativePath}`);
  }

  return absoluteTarget;
}

function renderFiles(
  rootDir: string,
  kind: ScaffoldKind,
  name: ScaffoldNameParts,
): ScaffoldRenderedFileSpec[] {
  const rendered = renderScaffoldFiles(kind, name);
  return rendered.map((file) => ({
    ...file,
    absolutePath: resolveRelativeWithinRoot(rootDir, file.relativePath),
  }));
}

export function buildScaffoldPlan(request: ScaffoldRequest): ScaffoldPlan {
  const kind = assertScaffoldKind(request.kind);
  const template = getScaffoldTemplate(kind);
  const rootDir = assertRootDir(request.rootDir);
  const name = normalizeScaffoldName(request.name);
  const files = renderFiles(rootDir, kind, name);

  return {
    rootDir,
    kind,
    name,
    template,
    files,
    notes: [...template.notes],
  };
}

async function writeScaffoldFile(file: ScaffoldRenderedFileSpec): Promise<string> {
  if (existsSync(file.absolutePath)) {
    throw new ScaffoldError("target-exists", `File already exists: ${file.relativePath}`, {
      path: file.absolutePath,
    });
  }

  await mkdir(resolve(file.absolutePath, ".."), { recursive: true });
  await writeFile(file.absolutePath, file.content, "utf-8");
  return file.absolutePath;
}

export async function materializeScaffold(plan: ScaffoldPlan): Promise<ScaffoldExecutionResult> {
  const createdFiles: string[] = [];
  for (const file of plan.files) {
    try {
      createdFiles.push(await writeScaffoldFile(file));
    } catch (error) {
      if (error instanceof ScaffoldError) {
        throw error;
      }
      throw new ScaffoldError("write-failed", `Failed to write scaffold file: ${file.relativePath}`, {
        path: file.absolutePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    plan,
    createdFiles,
    dryRun: false,
  };
}

export async function generateScaffold(request: ScaffoldRequest): Promise<ScaffoldExecutionResult> {
  const plan = buildScaffoldPlan(request);
  if (request.dryRun) {
    return {
      plan,
      createdFiles: [],
      dryRun: true,
    };
  }

  return await materializeScaffold(plan);
}
