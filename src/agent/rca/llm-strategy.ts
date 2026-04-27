/**
 * Wave 10 P2 / F6 — Opt-in LLM strategy for RCA hypothesis scoring.
 *
 * Activated only when `RCA_LLM_ENABLED=true` AND `ANTHROPIC_API_KEY` is set.
 * Calls Anthropic Claude (default: claude-haiku-4-5-20251001) to score
 * existing hypotheses on a 0-1 scale and propose up to 2 new hypotheses.
 * Best-effort: any failure (env off, key missing, network, parse error,
 * timeout) returns `{ used: false, fallbackReason }` so the caller can fall
 * back to the deterministic heuristic scorer.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IncidentRecord } from "../incident/types.js";
import type { ScoredHypothesis } from "./types.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_TOKENS = 1000;
const MAX_NEW_HYPOTHESES = 2;
const MAX_EVIDENCE_IN_PROMPT = 5;

const SYSTEM_PROMPT =
  "You are a Root Cause Analysis assistant. Given an incident's symptoms, " +
  "evidence, and existing hypotheses, score each hypothesis on a 0-1 scale " +
  "and propose up to 2 new hypotheses. Reply ONLY with JSON.";

export interface LLMStrategyOptions {
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LLMStrategyResult {
  hypotheses: ScoredHypothesis[];
  /** Up to 2 new hypotheses LLM suggests for "testing" status. */
  newHypotheses?: ScoredHypothesis[];
  /** True when LLM call succeeded. False = caller should run heuristic. */
  used: boolean;
  /** Why fallback happened (if used: false). */
  fallbackReason?: string;
}

interface RawScoredItem {
  text: unknown;
  score: unknown;
  reasoning?: unknown;
}

interface RawLLMResponse {
  scored?: unknown;
  new?: unknown;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 10000) / 10000;
}

function isRawScoredItem(v: unknown): v is RawScoredItem {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RawScoredItem).text === "string" &&
    typeof (v as RawScoredItem).score === "number"
  );
}

/**
 * Extract JSON from raw text — try direct parse first, then look for
 * the first ```json ... ``` block, then the first {...} balanced block.
 */
function extractJson(text: string): RawLLMResponse | null {
  const trimmed = text.trim();
  // Direct parse
  try {
    return JSON.parse(trimmed) as RawLLMResponse;
  } catch {
    // Fall through
  }
  // Code block ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as RawLLMResponse;
    } catch {
      // Fall through
    }
  }
  // First balanced { ... }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as RawLLMResponse;
    } catch {
      // Fall through
    }
  }
  return null;
}

function buildUserPrompt(incident: IncidentRecord): string {
  const symptoms = incident.symptoms.length
    ? incident.symptoms.map((s) => `- ${s}`).join("\n")
    : "- (none)";
  const evidence = incident.evidence.length
    ? incident.evidence
        .slice(0, MAX_EVIDENCE_IN_PROMPT)
        .map((e) => `- [${e.type}] ${e.value}`)
        .join("\n")
    : "- (none)";
  const hypotheses = incident.hypotheses.length
    ? incident.hypotheses
        .map((h) => `- ${h.text} (status: ${h.status})`)
        .join("\n")
    : "- (none)";

  return [
    `Incident: ${incident.title}`,
    `Severity: ${incident.severity}`,
    "",
    "Symptoms:",
    symptoms,
    "",
    "Evidence:",
    evidence,
    "",
    "Existing hypotheses:",
    hypotheses,
    "",
    "Respond with JSON:",
    "{",
    '  "scored": [{"text": "...", "score": 0.0-1.0, "reasoning": "..."}],',
    '  "new": [{"text": "...", "score": 0.0-1.0}]',
    "}",
  ].join("\n");
}

/**
 * Map raw LLM scored items back to ScoredHypothesis, preserving the
 * status of any incident hypothesis with the same text. "confirmed" /
 * "rejected" statuses keep the deterministic heuristic anchors
 * (0.95 / 0.05) so the LLM only adjusts "testing" scores.
 */
function mapScoredHypotheses(
  raw: unknown,
  incident: IncidentRecord,
): ScoredHypothesis[] {
  if (!Array.isArray(raw)) return [];
  const byText = new Map<string, IncidentHypothesisLike>();
  for (const h of incident.hypotheses) {
    byText.set(h.text, h);
  }
  const result: ScoredHypothesis[] = [];
  for (const item of raw) {
    if (!isRawScoredItem(item)) continue;
    const text = (item.text as string).trim();
    if (!text) continue;
    const existing = byText.get(text);
    const status = existing?.status ?? "testing";
    let score: number;
    if (status === "confirmed") {
      score = 0.95;
    } else if (status === "rejected") {
      score = 0.05;
    } else {
      score = clampScore(item.score as number);
    }
    result.push({ text, status, score });
  }
  return result;
}

interface IncidentHypothesisLike {
  status: "testing" | "rejected" | "confirmed";
}

function mapNewHypotheses(raw: unknown): ScoredHypothesis[] {
  if (!Array.isArray(raw)) return [];
  const result: ScoredHypothesis[] = [];
  for (const item of raw) {
    if (!isRawScoredItem(item)) continue;
    const text = (item.text as string).trim();
    if (!text) continue;
    result.push({
      text,
      status: "testing",
      score: clampScore(item.score as number),
    });
    if (result.length >= MAX_NEW_HYPOTHESES) break;
  }
  return result;
}

/**
 * Score hypotheses + suggest new ones via Anthropic Claude.
 * Best-effort: returns `{ used: false, fallbackReason }` on any failure.
 */
export async function scoreHypothesesViaLLM(
  incident: IncidentRecord,
  options?: LLMStrategyOptions,
): Promise<LLMStrategyResult> {
  if (process.env.RCA_LLM_ENABLED !== "true") {
    return {
      used: false,
      fallbackReason: "RCA_LLM_ENABLED not set",
      hypotheses: [],
    };
  }

  const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      used: false,
      fallbackReason: "ANTHROPIC_API_KEY not set",
      hypotheses: [],
    };
  }

  const model = options?.model ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const userPrompt = buildUserPrompt(incident);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new Anthropic({ apiKey });
    const callPromise = client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
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
      return {
        used: false,
        fallbackReason: "LLM response missing text block",
        hypotheses: [],
      };
    }

    const parsed = extractJson(firstBlock.text);
    if (!parsed) {
      return {
        used: false,
        fallbackReason: "LLM response not valid JSON",
        hypotheses: [],
      };
    }

    const scored = mapScoredHypotheses(parsed.scored, incident);
    const newHypotheses = mapNewHypotheses(parsed.new);

    // Sort scored by score desc to mirror heuristic behavior.
    scored.sort((a, b) => b.score - a.score);

    return {
      used: true,
      hypotheses: scored,
      newHypotheses,
    };
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    return {
      used: false,
      fallbackReason: `LLM call failed: ${message}`,
      hypotheses: [],
    };
  }
}
