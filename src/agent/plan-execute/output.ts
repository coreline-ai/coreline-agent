import type { EvaluationResult, TaskArtifact, TaskOutput } from "./types.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeArtifact(entry: unknown): TaskArtifact | null {
  const rec = asRecord(entry);
  if (!rec) return null;

  const kind = asString(rec.kind);
  const label = asString(rec.label);
  const value = asString(rec.value ?? rec.path ?? rec.text ?? rec.summary);
  if (!kind || !label || !value) return null;

  if (kind !== "summary" && kind !== "file" && kind !== "path" && kind !== "output" && kind !== "verification") {
    return null;
  }

  return { kind, label, value } as TaskArtifact;
}

export function normalizeTaskArtifacts(result: unknown): TaskArtifact[] {
  const artifacts: TaskArtifact[] = [];
  const rec = asRecord(result);

  const explicit = Array.isArray(rec?.artifacts)
    ? rec.artifacts.map(normalizeArtifact).filter((entry): entry is TaskArtifact => Boolean(entry))
    : [];
  artifacts.push(...explicit);

  const summary = asString(rec?.summary);
  if (summary) {
    artifacts.push({ kind: "summary", label: "summary", value: summary });
  }

  const finalText = asString(rec?.finalText);
  if (finalText) {
    artifacts.push({ kind: "output", label: "finalText", value: finalText });
  }

  const path = asString(rec?.path);
  if (path) {
    artifacts.push({ kind: "path", label: "path", value: path });
  }

  const output = asString(rec?.output);
  if (output) {
    artifacts.push({ kind: "output", label: "output", value: output });
  }

  const deduped = new Map<string, TaskArtifact>();
  for (const artifact of artifacts) {
    deduped.set(`${artifact.kind}:${artifact.label}:${artifact.value}`, artifact);
  }
  return [...deduped.values()];
}

export function summarizeTaskResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  const rec = asRecord(result);
  if (!rec) return undefined;

  return (
    asString(rec.summary)
    ?? asString(rec.finalText)
    ?? asString(rec.message)
    ?? asString(rec.reason)
    ?? asString(rec.output)
    ?? undefined
  );
}

export function normalizeTaskOutput(result: unknown, evaluation?: EvaluationResult): TaskOutput {
  const artifacts = normalizeTaskArtifacts(result);
  const rec = asRecord(result);
  const summary = summarizeTaskResult(result);

  return {
    summary,
    finalText: asString(rec?.finalText) ?? (typeof result === "string" ? result : undefined),
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    verificationSummary: asString(rec?.verificationSummary) ?? evaluation?.reason,
  };
}
