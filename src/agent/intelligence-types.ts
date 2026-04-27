import type { PipelineRequest, PipelineResult, PipelineStage } from "./pipeline-types.js";

export interface ContextCollectionRequest {
  cwd: string;
  prompt: string;
  maxCandidates?: number;
  maxFileSizeBytes?: number;
  includeExtensions?: string[];
  excludeDirs?: string[];
  mentionedFiles?: string[];
  mentionedSymbols?: string[];
}

export type ContextCandidateReason =
  | "mentioned-file"
  | "path-fragment"
  | "symbol-match"
  | "imports-mentioned-file"
  | "imported-by-mentioned-file";

export interface ContextCandidate {
  path: string;
  score: number;
  reasons: ContextCandidateReason[];
  sizeBytes: number;
  imports?: string[];
  importedBy?: string[];
  matchedSymbols?: string[];
}

export type ContextExcludedReason = "binary" | "oversized" | "secret-like" | "unsupported-extension" | "not-found";

export interface ContextExcludedCandidate {
  path: string;
  reason: ContextExcludedReason;
  detail?: string;
}

export interface ContextCollectionResult {
  cwd: string;
  candidates: ContextCandidate[];
  excluded: ContextExcludedCandidate[];
  mentionedFiles: string[];
  mentionedSymbols: string[];
}

export type PromptMacroFailurePolicy = "stop" | "continue";

export interface PromptMacroStep {
  id?: string;
  name?: string;
  prompt: string;
  contextPrefix?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  ownedPaths?: string[];
  nonOwnedPaths?: string[];
  contracts?: string[];
  mergeNotes?: string;
  macroRef?: string;
}

export interface PromptMacro {
  id: string;
  name: string;
  description?: string;
  steps: PromptMacroStep[];
  onStepFailure?: PromptMacroFailurePolicy;
  maxSteps?: number;
}

export interface PromptMacroValidationIssue {
  path: string;
  message: string;
}

export interface PromptMacroValidationResult {
  ok: boolean;
  issues: PromptMacroValidationIssue[];
}

export interface PromptMacroRunRequest {
  macro: PromptMacro;
  goal?: string;
  maxSteps?: number;
}

export interface PromptMacroRunResult {
  macroId: string;
  success: boolean;
  pipeline: PipelineResult;
}

export interface PromptMacroPipelineAdapterResult {
  request: PipelineRequest;
  stages: PipelineStage[];
}

export type BenchmarkExpectedOutcome = "success" | "failure" | "ambiguous";

export interface BenchmarkScenario {
  id: string;
  name: string;
  prompt: string;
  expected: BenchmarkExpectedOutcome;
  mockResponse?: string;
  tags?: string[];
  timeoutMs?: number;
}

export type BenchmarkResultStatus = "passed" | "failed";

export interface BenchmarkResult {
  scenarioId: string;
  name: string;
  status: BenchmarkResultStatus;
  expected: BenchmarkExpectedOutcome;
  actual: BenchmarkExpectedOutcome;
  output: string;
  elapsedMs: number;
  error?: string;
}

export interface BenchmarkRunSummary {
  results: BenchmarkResult[];
  passed: number;
  failed: number;
  success: boolean;
  elapsedMs: number;
}
