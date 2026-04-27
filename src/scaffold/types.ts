/**
 * Scaffold core types.
 *
 * The scaffold layer is intentionally pure and TUI-agnostic:
 * it can build a preview plan, validate file targets, and materialize files
 * later when the main agent wires a command into the UI.
 */

export type ScaffoldKind = "tool" | "provider" | "test" | "slash-command" | "hook";

export type ScaffoldErrorCode =
  | "invalid-kind"
  | "invalid-name"
  | "invalid-root"
  | "path-traversal"
  | "target-exists"
  | "write-failed"
  | "template-error";

export interface ScaffoldNameParts {
  readonly input: string;
  readonly normalized: string;
  readonly kebab: string;
  readonly camel: string;
  readonly pascal: string;
  readonly words: readonly string[];
}

export interface ScaffoldTemplateFileSpec {
  readonly relativePathTemplate: string;
  readonly contentTemplate: string;
  readonly description: string;
}

export interface ScaffoldTemplateDefinition {
  readonly kind: ScaffoldKind;
  readonly label: string;
  readonly summary: string;
  readonly files: readonly ScaffoldTemplateFileSpec[];
  readonly notes: readonly string[];
}

export type ScaffoldFileSpec = ScaffoldTemplateFileSpec;
export type ScaffoldTemplate = ScaffoldTemplateDefinition;

export interface ScaffoldRenderedFileSpec {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly description: string;
  readonly content: string;
}

export interface ScaffoldPlan {
  readonly rootDir: string;
  readonly kind: ScaffoldKind;
  readonly name: ScaffoldNameParts;
  readonly template: ScaffoldTemplateDefinition;
  readonly files: readonly ScaffoldRenderedFileSpec[];
  readonly notes: readonly string[];
}

export interface ScaffoldRequest {
  readonly rootDir: string;
  readonly kind: ScaffoldKind;
  readonly name: string;
  readonly dryRun?: boolean;
}

export interface ScaffoldExecutionResult {
  readonly plan: ScaffoldPlan;
  readonly createdFiles: readonly string[];
  readonly dryRun: boolean;
}

export type ScaffoldResult = ScaffoldExecutionResult;

export class ScaffoldError extends Error {
  readonly code: ScaffoldErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ScaffoldErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ScaffoldError";
    this.code = code;
    this.details = details;
  }
}
