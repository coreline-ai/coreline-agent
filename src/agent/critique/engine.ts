/**
 * 5-dimensional critique framework — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 *
 * Engine entrypoint: tries the LLM strategy first (when enabled and an API
 * key is present) and falls back to the deterministic heuristic on any
 * failure. Mirrors the F6 pattern from `src/agent/rca/llm-strategy.ts`.
 *
 * Env opt-out: `CRITIQUE_LLM_ENABLED=false` forces heuristic mode.
 */

import Anthropic from "@anthropic-ai/sdk";
import { computeHeuristicCritique } from "./heuristic-fallback.js";
import {
  CRITIQUE_SYSTEM_PROMPT,
  buildCritiqueUserPrompt,
} from "./prompt-builder.js";
import {
  CRITIQUE_DIMENSIONS,
  type CritiqueDimension,
  type CritiqueFix,
  type CritiqueFixSeverity,
  type CritiqueOptions,
  type CritiqueResult,
  type CritiqueScore,
} from "./types.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_TOKENS = 1500;

interface RawScore {
  dimension: unknown;
  score: unknown;
  reasoning?: unknown;
}

interface RawFix {
  severity: unknown;
  issue: unknown;
  suggestion: unknown;
}

interface RawLLMResponse {
  scores?: unknown;
  keep?: unknown;
  fix?: unknown;
  quickWins?: unknown;
}

function clampScore10(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 5;
  if (n < 1) return 1;
  if (n > 10) return 10;
  return Math.round(n * 10) / 10;
}

function isDimension(v: unknown): v is CritiqueDimension {
  return (
    typeof v === "string" &&
    (CRITIQUE_DIMENSIONS as readonly string[]).includes(v)
  );
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function isFixSeverity(v: unknown): v is CritiqueFixSeverity {
  return v === "error" || v === "warning" || v === "optimization";
}

/**
 * Best-effort JSON extraction: direct parse → fenced ```json``` → first
 * balanced { ... } block.
 */
function extractJson(text: string): RawLLMResponse | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as RawLLMResponse;
  } catch {
    // fall through
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as RawLLMResponse;
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as RawLLMResponse;
    } catch {
      // fall through
    }
  }
  return null;
}

function mapScores(raw: unknown): CritiqueScore[] {
  if (!Array.isArray(raw)) return [];
  const byDimension = new Map<CritiqueDimension, CritiqueScore>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as RawScore;
    if (!isDimension(r.dimension)) continue;
    byDimension.set(r.dimension, {
      dimension: r.dimension,
      score: clampScore10(r.score),
      reasoning: asString(r.reasoning, "(no reasoning provided)"),
    });
  }
  // Preserve canonical dimension order; fill missing dimensions with neutral 5.
  const result: CritiqueScore[] = [];
  for (const dim of CRITIQUE_DIMENSIONS) {
    const existing = byDimension.get(dim);
    if (existing) {
      result.push(existing);
    } else {
      result.push({
        dimension: dim,
        score: 5,
        reasoning: "(LLM omitted this dimension; defaulted to 5.)",
      });
    }
  }
  return result;
}

function mapKeep(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out.slice(0, 5);
}

function mapFix(raw: unknown): CritiqueFix[] {
  if (!Array.isArray(raw)) return [];
  const out: CritiqueFix[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as RawFix;
    const severity: CritiqueFixSeverity = isFixSeverity(r.severity)
      ? r.severity
      : "warning";
    const issue = asString(r.issue).trim();
    const suggestion = asString(r.suggestion).trim();
    if (!issue && !suggestion) continue;
    out.push({
      severity,
      issue: issue || "(no issue text)",
      suggestion: suggestion || "(no suggestion provided)",
    });
  }
  return out;
}

function mapQuickWins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out.slice(0, 3);
}

function averageScore(scores: CritiqueScore[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((acc, s) => acc + s.score, 0);
  return Math.round((sum / scores.length) * 10) / 10;
}

function isValidLLMResult(parsed: RawLLMResponse): boolean {
  // Require at least a scores array. keep/fix/quickWins are recoverable.
  return Array.isArray(parsed.scores) && parsed.scores.length > 0;
}

export interface ComputeCritiqueParams {
  targetPath: string;
  content: string;
  options?: CritiqueOptions;
}

/**
 * Compute a 5-dimensional critique. Always resolves with a CritiqueResult —
 * never throws. Falls back to the heuristic strategy on any LLM failure.
 */
export async function computeCritique(
  params: ComputeCritiqueParams,
): Promise<CritiqueResult> {
  const { targetPath, content, options } = params;
  const heuristicResult = (): CritiqueResult =>
    computeHeuristicCritique({ targetPath, content });

  // Explicit strategy override.
  if (options?.strategy === "heuristic") {
    return heuristicResult();
  }

  // Env opt-out (default ON).
  if (process.env.CRITIQUE_LLM_ENABLED === "false") {
    return heuristicResult();
  }

  const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (options?.strategy === "llm") {
      // Caller forced LLM but no key — still fall back rather than throwing.
      console.warn(
        "[critique] ANTHROPIC_API_KEY not set; falling back to heuristic strategy.",
      );
    }
    return heuristicResult();
  }

  const model = options?.model ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const userPrompt = buildCritiqueUserPrompt({
    targetPath,
    content,
    philosophy: options?.philosophy,
    context: options?.context,
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new Anthropic({ apiKey });
    const callPromise = client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: CRITIQUE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("LLM request timeout")),
        timeoutMs,
      );
    });

    const response = (await Promise.race([
      callPromise,
      timeoutPromise,
    ])) as Awaited<typeof callPromise>;

    if (timeoutHandle) clearTimeout(timeoutHandle);

    const firstBlock = response.content?.[0];
    if (!firstBlock || firstBlock.type !== "text") {
      console.warn("[critique] LLM response missing text block; using heuristic.");
      return heuristicResult();
    }

    const parsed = extractJson(firstBlock.text);
    if (!parsed || !isValidLLMResult(parsed)) {
      console.warn("[critique] LLM response not parseable; using heuristic.");
      return heuristicResult();
    }

    const scores = mapScores(parsed.scores);
    const keep = mapKeep(parsed.keep);
    const fix = mapFix(parsed.fix);
    const quickWins = mapQuickWins(parsed.quickWins);

    return {
      targetPath,
      overallScore: averageScore(scores),
      scores,
      keep,
      fix,
      quickWins,
      strategy: "llm",
    };
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[critique] LLM call failed (${message}); using heuristic.`);
    return heuristicResult();
  }
}
