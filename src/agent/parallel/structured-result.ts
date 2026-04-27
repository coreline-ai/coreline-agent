import type {
  ParallelAgentMinimalResult,
  ParallelAgentStructuredResult,
  ParallelAgentStructuredStatus,
} from "./types.js";

export interface ParallelAgentResultEnvelope {
  kind: "structured" | "minimal" | "fallback";
  status: ParallelAgentStructuredStatus;
  summary: string;
  finalText: string;
  rawText: string;
  errors: string[];
  structuredResult?: ParallelAgentStructuredResult;
  minimalResult?: ParallelAgentMinimalResult;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeStatus(value: unknown): ParallelAgentStructuredStatus | undefined {
  if (value === "completed" || value === "partial" || value === "failed" || value === "blocked") {
    return value;
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = trimString(entry);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeTestsRun(value: unknown): ParallelAgentStructuredResult["testsRun"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ParallelAgentStructuredResult["testsRun"] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const command = trimString(entry.command);
    const status = entry.status === "pass" || entry.status === "fail" || entry.status === "skipped" ? entry.status : undefined;
    if (!command || !status) {
      continue;
    }
    result.push({
      command,
      status,
      outputSummary: trimString(entry.outputSummary),
    });
  }
  return result;
}

export function stripMarkdownCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json|JSON)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  return trimmed;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function buildStructuredResult(data: Record<string, unknown>): ParallelAgentStructuredResult | undefined {
  const status = normalizeStatus(data.status);
  const summary = trimString(data.summary);
  if (!status || !summary) {
    return undefined;
  }

  const hasDetailFields = ["changedFiles", "readFiles", "commandsRun", "testsRun", "risks", "nextActions"]
    .some((key) => key in data);
  if (!hasDetailFields) {
    return undefined;
  }

  return {
    status,
    summary,
    changedFiles: normalizeStringArray(data.changedFiles),
    readFiles: normalizeStringArray(data.readFiles),
    commandsRun: normalizeStringArray(data.commandsRun),
    testsRun: normalizeTestsRun(data.testsRun),
    risks: normalizeStringArray(data.risks),
    nextActions: normalizeStringArray(data.nextActions),
  };
}

function buildMinimalResult(data: Record<string, unknown>): ParallelAgentMinimalResult | undefined {
  const status = normalizeStatus(data.status);
  const summary = trimString(data.summary);
  if (!status || !summary) {
    return undefined;
  }

  return { status, summary };
}

export function normalizeParallelAgentResult(
  input: unknown,
  fallbackFinalText = "",
): ParallelAgentResultEnvelope {
  const rawText = typeof input === "string" ? stripMarkdownCodeFences(input) : isPlainObject(input) ? JSON.stringify(input) : "";
  const errors: string[] = [];
  const fallback = trimString(fallbackFinalText) ?? "";

  const parsed = typeof input === "string"
    ? tryParseJson(rawText)
    : input;

  if (isPlainObject(parsed)) {
    const structured = buildStructuredResult(parsed);
    if (structured) {
      return {
        kind: "structured",
        status: structured.status,
        summary: structured.summary,
        finalText: fallback || structured.summary,
        rawText,
        errors,
        structuredResult: structured,
      };
    }

    const minimal = buildMinimalResult(parsed);
    if (minimal) {
      return {
        kind: "minimal",
        status: minimal.status,
        summary: minimal.summary,
        finalText: fallback || minimal.summary,
        rawText,
        errors,
        minimalResult: minimal,
      };
    }

    errors.push("Result JSON did not contain a valid structured or minimal payload.");
  } else if (typeof input === "string" && rawText) {
    errors.push("Result text was not valid JSON.");
  }

  if (fallback) {
    return {
      kind: "fallback",
      status: "partial",
      summary: fallback,
      finalText: fallback,
      rawText,
      errors,
    };
  }

  if (typeof input === "string" && rawText && !looksLikeJson(rawText)) {
    return {
      kind: "fallback",
      status: "partial",
      summary: rawText,
      finalText: rawText,
      rawText,
      errors,
    };
  }

  return {
    kind: "fallback",
    status: "failed",
    summary: "(no summary)",
    finalText: "",
    rawText,
    errors,
  };
}

export function parseParallelAgentResultText(
  text: string,
  fallbackFinalText = "",
): ParallelAgentResultEnvelope {
  return normalizeParallelAgentResult(text, fallbackFinalText);
}
