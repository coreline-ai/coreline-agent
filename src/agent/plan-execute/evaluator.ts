/**
 * Minimal evaluation implementation.
 */

import type { Task, Evaluator, EvaluationResult, TaskArtifact, VerificationContract, VerificationHint } from "./types.js";
import { normalizeTaskArtifacts, summarizeTaskResult } from "./output.js";

const FAILURE_PATTERNS = [
  /\bnot implemented\b/i,
  /\bpermission denied\b/i,
  /\bnot found\b/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /\bexception\b/i,
  /\btimeout\b/i,
  /\babort(?:ed)?\b/i,
  /\bservice unavailable\b/i,
  /\bprovider unavailable\b/i,
  /\btemporar(?:y|ily) unavailable\b/i,
  /\brate limit(?:ed)?\b/i,
  /\bnetwork (?:error|offline|unavailable)\b/i,
  /\bconnection (?:refused|reset)\b/i,
  /\bECONN(?:RESET|REFUSED|ABORTED)\b/i,
];

const SUCCESS_PATTERNS = [
  /\bsuccess(?:ful|fully)?\b/i,
  /\bcompleted\b/i,
  /\bdone\b/i,
  /\bok\b/i,
  /\bpassed\b/i,
];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function findVerificationRecord(result: unknown): Record<string, unknown> | null {
  const rec = extractRecord(result);
  if (!rec) {
    return null;
  }

  const directVerification = extractRecord(rec.verification);
  if (directVerification) {
    return directVerification;
  }

  const directEvaluation = extractRecord(rec.evaluation);
  if (directEvaluation) {
    return directEvaluation;
  }

  const metadata = extractRecord(rec.metadata);
  if (metadata) {
    const nestedVerification = extractRecord(metadata.verification);
    if (nestedVerification) {
      return nestedVerification;
    }

    const nestedEvaluation = extractRecord(metadata.evaluation);
    if (nestedEvaluation) {
      return nestedEvaluation;
    }
  }

  return null;
}

function normalizeVerificationContract(value: unknown): VerificationContract | undefined {
  const contract = asString(value)?.toLowerCase();
  if (contract === "exit_code" || contract === "artifact" || contract === "assertion") {
    return contract;
  }

  return undefined;
}

function findExitCode(result: unknown): number | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const rec = result as Record<string, unknown>;
  for (const key of ["exitCode", "exit_code", "code", "statusCode"]) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  const nestedData = extractRecord(rec.data);
  if (nestedData) {
    for (const key of ["exitCode", "exit_code", "code", "statusCode"]) {
      const value = nestedData[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
  }

  return null;
}

function selectAssertionText(result: unknown, hint: VerificationHint): string | null {
  const rec = extractRecord(result);
  if (hint.assertionTarget === "summary") {
    return asString(rec?.summary) ?? summarizeTaskResult(result) ?? null;
  }
  if (hint.assertionTarget === "finalText") {
    return asString(rec?.finalText) ?? null;
  }

  return summarizeTaskResult(result) ?? asString(rec?.output) ?? asString(result);
}

function matchesArtifact(artifacts: TaskArtifact[], hint: VerificationHint): boolean {
  return artifacts.some((artifact) => {
    if (hint.artifactKind && artifact.kind !== hint.artifactKind) {
      const compatiblePathKinds = (hint.artifactKind === "file" || hint.artifactKind === "path")
        && (artifact.kind === "file" || artifact.kind === "path");
      if (!compatiblePathKinds) {
        return false;
      }
    }

    if (!hint.artifactLabel) {
      return true;
    }

    return artifact.label === hint.artifactLabel || artifact.value === hint.artifactLabel;
  });
}

function evaluateWithHint(task: Task, result: unknown): EvaluationResult | null {
  const hint = task.verificationHint;
  if (!hint) {
    return null;
  }

  if (hint.contract === "exit_code") {
    const exitCode = findExitCode(result);
    if (exitCode === null) {
      return null;
    }
    const expected = hint.expectedExitCode ?? 0;
    return {
      success: exitCode === expected,
      outcome: exitCode === expected ? "success" : "failure",
      reason: exitCode === expected
        ? `exit code ${exitCode} matched expected ${expected}`
        : `exit code ${exitCode} did not match expected ${expected}`,
      strategy: "deterministic",
      contract: "exit_code",
    };
  }

  if (hint.contract === "artifact") {
    const artifacts = normalizeTaskArtifacts(result);
    const matched = matchesArtifact(artifacts, hint);
    const target = hint.artifactLabel ?? hint.artifactKind ?? "artifact";
    return {
      success: matched,
      outcome: matched ? "success" : "failure",
      reason: matched ? `artifact contract matched ${target}` : `artifact contract missing ${target}`,
      strategy: "deterministic",
      contract: "artifact",
    };
  }

  if (hint.contract === "assertion") {
    const text = selectAssertionText(result, hint);
    if (!text) {
      return null;
    }

    let matched = false;
    let expectation = hint.assertionText ?? hint.assertionPattern ?? "assertion";
    if (hint.assertionPattern) {
      try {
        matched = new RegExp(hint.assertionPattern, "i").test(text);
      } catch {
        matched = false;
      }
    } else if (hint.assertionText) {
      matched = text.toLowerCase().includes(hint.assertionText.toLowerCase());
    }

    return {
      success: matched,
      outcome: matched ? "success" : "failure",
      reason: matched ? `assertion matched ${expectation}` : `assertion missing ${expectation}`,
      strategy: "deterministic",
      contract: "assertion",
    };
  }

  return null;
}

function collectResultTexts(result: unknown): string[] {
  const texts: string[] = [];

  if (result instanceof Error) {
    texts.push(result.message);
    return texts;
  }

  const direct = asString(result);
  if (direct) {
    texts.push(direct);
    return texts;
  }

  if (!result || typeof result !== "object") {
    return texts;
  }

  const rec = result as Record<string, unknown>;
  const candidateKeys = [
    "finalText",
    "summary",
    "text",
    "message",
    "output",
    "result",
    "reason",
    "error",
  ];

  for (const key of candidateKeys) {
    const text = asString(rec[key]);
    if (text) {
      texts.push(text);
    }
  }

  if (rec.data && typeof rec.data === "object") {
    texts.push(...collectResultTexts(rec.data));
  }

  if (Array.isArray(rec.errors)) {
    for (const entry of rec.errors) {
      const text = asString(entry);
      if (text) {
        texts.push(text);
      }
    }
  }

  return texts;
}

function normalizeExplicitVerification(result: unknown): EvaluationResult | null {
  const verification = findVerificationRecord(result);
  if (!verification) {
    return null;
  }

  const outcome = asString(verification.outcome);
  const status = asString(verification.status)?.toLowerCase();
  const reason = asString(verification.reason) ?? asString(verification.message) ?? asString(verification.summary) ?? undefined;
  const strategy = asString(verification.strategy)?.toLowerCase();
  const normalizedStrategy: EvaluationResult["strategy"] =
    strategy === "deterministic" || strategy === "structural" || strategy === "llm"
      ? strategy
      : "deterministic";
  const contract = normalizeVerificationContract(verification.contract);

  if (outcome === "success" || outcome === "failure" || outcome === "ambiguous") {
    return {
      success: outcome !== "failure",
      outcome,
      reason,
      strategy: normalizedStrategy,
      contract,
    };
  }

  if (typeof verification.success === "boolean") {
    return {
      success: verification.success,
      outcome: verification.success ? "success" : "failure",
      reason,
      strategy: normalizedStrategy,
      contract,
    };
  }

  if (status === "passed" || status === "failed" || status === "ambiguous") {
    return {
      success: status !== "failed",
      outcome: status === "passed" ? "success" : status === "failed" ? "failure" : "ambiguous",
      reason,
      strategy: normalizedStrategy,
      contract,
    };
  }

  if (typeof verification.isError === "boolean") {
    return {
      success: !verification.isError,
      outcome: verification.isError ? "failure" : "success",
      reason,
      strategy: normalizedStrategy,
      contract,
    };
  }

  return null;
}

function findExplicitOutcome(result: unknown): EvaluationResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }

  const rec = result as Record<string, unknown>;
  const outcome = asString(rec.outcome);
  if (outcome === "success" || outcome === "failure" || outcome === "ambiguous") {
    if (outcome === "failure") {
      return {
        success: false,
        outcome: "failure",
        reason: asString(rec.reason) ?? asString(rec.message) ?? undefined,
        strategy: "deterministic",
      };
    }

    return {
      success: true,
      outcome: outcome === "ambiguous" ? "ambiguous" : "success",
      reason: asString(rec.reason) ?? asString(rec.message) ?? undefined,
      strategy: "deterministic",
    };
  }

  if (typeof rec.success === "boolean") {
    return {
      success: rec.success,
      outcome: rec.success ? "success" : "failure",
      reason: asString(rec.reason) ?? asString(rec.message) ?? undefined,
      strategy: "deterministic",
    };
  }

  if (asString(rec.status)) {
    const status = asString(rec.status);
    if (status && ["completed", "success", "succeeded", "ok", "done"].includes(status.toLowerCase())) {
      return {
        success: true,
        outcome: "success",
        reason: asString(rec.reason) ?? undefined,
        strategy: "deterministic",
      };
    }
    if (status && ["failed", "failure", "error", "aborted", "timeout"].includes(status.toLowerCase())) {
      return {
        success: false,
        outcome: "failure",
        reason: asString(rec.reason) ?? undefined,
        strategy: "deterministic",
      };
    }
  }

  if (typeof rec.isError === "boolean") {
    return {
      success: !rec.isError,
      outcome: rec.isError ? "failure" : "success",
      reason: asString(rec.reason) ?? asString(rec.message) ?? undefined,
      strategy: "deterministic",
    };
  }

  return null;
}

function classifyByText(text: string): EvaluationResult {
  const normalized = text.trim();
  if (!normalized) {
    return {
      success: false,
      outcome: "failure",
      reason: "empty result",
      strategy: "structural",
    };
  }

  if (FAILURE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      success: false,
      outcome: "failure",
      reason: normalized,
      strategy: "structural",
    };
  }

  if (SUCCESS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      success: true,
      outcome: "success",
      reason: normalized,
      strategy: "structural",
    };
  }

  return {
    success: true,
    outcome: "ambiguous",
    reason: "ambiguous result; treated as pass",
    strategy: "structural",
  };
}

export class BasicEvaluator implements Evaluator {
  async evaluate(task: Task, result: unknown): Promise<EvaluationResult> {
    const explicitVerification = normalizeExplicitVerification(result);
    if (explicitVerification) {
      return explicitVerification;
    }

    const explicit = findExplicitOutcome(result);
    if (explicit) {
      return explicit;
    }

    const hintEvaluation = evaluateWithHint(task, result);
    if (hintEvaluation) {
      return hintEvaluation;
    }

    const texts = collectResultTexts(result);
    if (texts.length > 0) {
      for (const text of texts) {
        const explicitText = classifyByText(text);
        if (explicitText.outcome !== "ambiguous") {
          return explicitText;
        }
      }

      return classifyByText(texts.join("\n"));
    }

    return {
      success: false,
      outcome: "failure",
      reason: "empty result",
      strategy: "structural",
    };
  }
}
