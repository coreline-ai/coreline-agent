import type {
  PromptMacro,
  PromptMacroPipelineAdapterResult,
  PromptMacroRunRequest,
  PromptMacroRunResult,
  PromptMacroStep,
  PromptMacroValidationIssue,
  PromptMacroValidationResult,
} from "../agent/intelligence-types.js";
import type { PipelineExecutor } from "../agent/pipeline-runner.js";
import { runPipeline } from "../agent/pipeline-runner.js";
import type { PipelineRequest, PipelineStage } from "../agent/pipeline-types.js";

const DEFAULT_MAX_MACRO_STEPS = 20;
const ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface PromptMacroValidationOptions {
  maxSteps?: number;
  catalog?: Map<string, PromptMacro> | Record<string, PromptMacro>;
}

function issue(path: string, message: string): PromptMacroValidationIssue {
  return { path, message };
}

function getCatalogMacro(catalog: PromptMacroValidationOptions["catalog"], id: string): PromptMacro | undefined {
  if (!catalog) {
    return undefined;
  }
  return catalog instanceof Map ? catalog.get(id) : catalog[id];
}

function detectMacroRefCycle(
  macro: PromptMacro,
  catalog: PromptMacroValidationOptions["catalog"],
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(macro.id)) {
    return macro.id;
  }
  seen.add(macro.id);
  for (const step of macro.steps) {
    if (!step.macroRef) {
      continue;
    }
    const next = getCatalogMacro(catalog, step.macroRef);
    if (!next) {
      continue;
    }
    const cyclic = detectMacroRefCycle(next, catalog, new Set(seen));
    if (cyclic) {
      return cyclic;
    }
  }
  return undefined;
}

export function validatePromptMacro(
  macro: PromptMacro,
  options: PromptMacroValidationOptions = {},
): PromptMacroValidationResult {
  const issues: PromptMacroValidationIssue[] = [];
  const maxSteps = options.maxSteps ?? macro.maxSteps ?? DEFAULT_MAX_MACRO_STEPS;

  if (!macro.id || !ID_RE.test(macro.id)) {
    issues.push(issue("id", "Macro id must contain only letters, numbers, underscores, and dashes"));
  }
  if (!macro.name?.trim()) {
    issues.push(issue("name", "Macro name is required"));
  }
  if (!Array.isArray(macro.steps) || macro.steps.length === 0) {
    issues.push(issue("steps", "Macro must contain at least one step"));
  }
  if (macro.steps.length > maxSteps) {
    issues.push(issue("steps", `Macro exceeds max steps (${macro.steps.length} > ${maxSteps})`));
  }
  if (macro.onStepFailure && !["stop", "continue"].includes(macro.onStepFailure)) {
    issues.push(issue("onStepFailure", "Failure policy must be stop or continue"));
  }

  macro.steps.forEach((step, index) => {
    if (!step.prompt?.trim()) {
      issues.push(issue(`steps.${index}.prompt`, "Step prompt is required"));
    }
    if (step.timeoutMs !== undefined && step.timeoutMs <= 0) {
      issues.push(issue(`steps.${index}.timeoutMs`, "Step timeout must be positive"));
    }
    if (step.macroRef && !getCatalogMacro(options.catalog, step.macroRef)) {
      issues.push(issue(`steps.${index}.macroRef`, `Referenced macro not found: ${step.macroRef}`));
    }
  });

  const cyclic = detectMacroRefCycle(macro, options.catalog);
  if (cyclic) {
    issues.push(issue("steps", `Macro reference cycle detected at ${cyclic}`));
  }

  return { ok: issues.length === 0, issues };
}

export function promptMacroStepToPipelineStage(step: PromptMacroStep): PipelineStage {
  return {
    prompt: step.prompt,
    contextPrefix: step.contextPrefix,
    provider: step.provider,
    model: step.model,
    timeoutMs: step.timeoutMs,
    allowedTools: step.allowedTools,
    ownedPaths: step.ownedPaths,
    nonOwnedPaths: step.nonOwnedPaths,
    contracts: step.contracts,
    mergeNotes: step.mergeNotes,
  };
}

export function promptMacroToPipelineRequest(
  macro: PromptMacro,
  options: { goal?: string; maxSteps?: number } = {},
): PromptMacroPipelineAdapterResult {
  const validation = validatePromptMacro(macro, { maxSteps: options.maxSteps });
  if (!validation.ok) {
    throw new Error(`Invalid prompt macro: ${validation.issues.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  }

  const stages = macro.steps.map(promptMacroStepToPipelineStage);
  const request: PipelineRequest = {
    stages,
    goal: options.goal ?? macro.description,
    onStageFailure: macro.onStepFailure === "continue" ? "skip" : "stop",
  };
  return { request, stages };
}

export async function runPromptMacro(
  request: PromptMacroRunRequest,
  executor: PipelineExecutor,
  signal?: AbortSignal,
): Promise<PromptMacroRunResult> {
  const pipelineRequest = promptMacroToPipelineRequest(request.macro, {
    goal: request.goal,
    maxSteps: request.maxSteps,
  }).request;
  const pipeline = await runPipeline(pipelineRequest, executor, signal);
  return {
    macroId: request.macro.id,
    success: pipeline.success,
    pipeline,
  };
}

export function parsePromptMacro(input: string): PromptMacro {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Macro input is empty");
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as PromptMacro;
    const validation = validatePromptMacro(parsed);
    if (!validation.ok) {
      throw new Error(`Invalid prompt macro: ${validation.issues.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
    }
    return parsed;
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [header, ...stepLines] = lines;
  const name = header?.replace(/^#\s*/, "") || "Prompt macro";
  const steps = stepLines
    .map((line) => line.replace(/^(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .map((prompt, index) => ({ id: `step-${index + 1}`, prompt }));

  const macro: PromptMacro = {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "prompt-macro",
    name,
    steps,
    onStepFailure: "stop",
  };

  const validation = validatePromptMacro(macro);
  if (!validation.ok) {
    throw new Error(`Invalid prompt macro: ${validation.issues.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  }
  return macro;
}
