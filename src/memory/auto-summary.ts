/**
 * Automatic conversation summary writer.
 *
 * Safe default:
 * - only runs for root conversations
 * - skips sub-agent / plan-execution internal loops
 * - can be disabled with --no-auto-summary or CORELINE_NO_AUTO_SUMMARY=1
 */

import type { ChatMessage } from "../agent/types.js";
import type { ProjectMemoryCore, MemoryEntry, GlobalUserMemoryCore } from "./types.js";
import { detectSensitiveMemoryContent } from "./safety.js";
import { defaultTierForType, todayIso } from "./tiering.js";

export const AUTO_SUMMARY_ENTRY_NAME = "auto_summary";
export const AUTO_SUMMARY_ENTRY_DESCRIPTION = "Auto-generated summary of the most recent completed conversation.";

const MAX_SUMMARY_BODY_CHARS = 4_500;
const MAX_HIGHLIGHTS = 6;
const MIN_SUMMARY_LENGTH = 80;

const DURABLE_KEYWORDS = [
  /\bremember(?:ed|ing)?\b/i,
  /\bprefer(?:ence|red|ring)?\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\buse\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\brule\b/i,
  /\bpolicy\b/i,
  /\bdecision\b/i,
  /\bproject\b/i,
  /\bmemory\b/i,
  /\bproxy\b/i,
  /\bmcp\b/i,
  /\bplan\b/i,
  /\bagenttool\b/i,
  /\bno-auto-summary\b/i,
];

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampText(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function getMessageText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return normalizeWhitespace(message.content);
  }

  return normalizeWhitespace(
    message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" "),
  );
}

function splitIntoCandidateSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function containsDurableSignal(text: string): boolean {
  return DURABLE_KEYWORDS.some((pattern) => pattern.test(text));
}

function extractHighlights(messages: ChatMessage[]): string[] {
  const seen = new Set<string>();
  const highlights: string[] = [];

  const recentMessages = messages.slice(-12);
  for (const message of recentMessages) {
    const text = getMessageText(message);
    if (!text) {
      continue;
    }

    const candidates = splitIntoCandidateSentences(text);
    for (const candidate of candidates) {
      const normalized = clampText(candidate, 180);
      if (!normalized || normalized.length < 24) {
        continue;
      }
      if (!containsDurableSignal(normalized)) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      highlights.push(normalized);
      if (highlights.length >= MAX_HIGHLIGHTS) {
        return highlights;
      }
    }
  }

  return highlights;
}

function getLatestText(messages: ChatMessage[], role: "user" | "assistant"): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== role) {
      continue;
    }
    const text = getMessageText(message);
    if (text) {
      return text;
    }
  }
  return "";
}

function shouldSkipAutoSummary(systemPrompt: string, messages: ChatMessage[], agentDepth: number): string | null {
  if (agentDepth > 0) {
    return "child agent conversations do not auto-summarize";
  }

  if (/#\s*Sub-Agent Mode\b/i.test(systemPrompt) || /delegated sub-agent/i.test(systemPrompt)) {
    return "delegated sub-agent conversations do not auto-summarize";
  }

  const internalPlanPrompt = messages.some((message) => {
    if (message.role !== "user") {
      return false;
    }
    const text = getMessageText(message);
    return /You are executing one step of a larger plan\./i.test(text) || /Current task:/i.test(text);
  });

  if (internalPlanPrompt) {
    return "plan execution steps do not auto-summarize";
  }

  return null;
}

export function buildAutoSummaryEntry(params: {
  messages: ChatMessage[];
  systemPrompt: string;
  agentDepth: number;
}): MemoryEntry | null {
  const skipReason = shouldSkipAutoSummary(params.systemPrompt, params.messages, params.agentDepth);
  if (skipReason) {
    return null;
  }

  const lastUser = getLatestText(params.messages, "user");
  const lastAssistant = getLatestText(params.messages, "assistant");
  const highlights = extractHighlights(params.messages);

  const hasSubstantiveConversation =
    params.messages.length >= 2 &&
    (highlights.length > 0 || normalizeWhitespace(lastUser).length >= MIN_SUMMARY_LENGTH || normalizeWhitespace(lastAssistant).length >= MIN_SUMMARY_LENGTH);

  if (!hasSubstantiveConversation) {
    return null;
  }

  const bodyLines = [
    "# Auto Summary",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Goal",
    lastUser ? clampText(lastUser, 260) : "(no user message found)",
    "",
    "## Outcome",
    lastAssistant ? clampText(lastAssistant, 260) : "(no assistant result found)",
  ];

  if (highlights.length > 0) {
    bodyLines.push("", "## Important points");
    for (const highlight of highlights) {
      bodyLines.push(`- ${highlight}`);
    }
  }

  const body = bodyLines.join("\n").trimEnd();
  if (body.length === 0) {
    return null;
  }

  const type: MemoryEntry["type"] = "project";
  return {
    name: AUTO_SUMMARY_ENTRY_NAME,
    type,
    description: AUTO_SUMMARY_ENTRY_DESCRIPTION,
    body: body.slice(0, MAX_SUMMARY_BODY_CHARS),
    filePath: "",
    tier: defaultTierForType(type),
    lastAccessed: todayIso(),
    accessCount: 1,
    importance: "medium",
  };
}

export function maybeWriteAutoSummary(params: {
  projectMemory?: ProjectMemoryCore;
  messages: ChatMessage[];
  systemPrompt: string;
  agentDepth: number;
  enabled?: boolean;
}): { written: boolean; skippedReason?: string } {
  const enabled = params.enabled ?? process.env.CORELINE_NO_AUTO_SUMMARY !== "1";
  if (!enabled) {
    return { written: false, skippedReason: "auto-summary disabled" };
  }

  const projectMemory = params.projectMemory;
  if (!projectMemory) {
    return { written: false, skippedReason: "project memory unavailable" };
  }

  const entry = buildAutoSummaryEntry({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    agentDepth: params.agentDepth,
  });

  if (!entry) {
    return { written: false, skippedReason: "no summary-worthy signal" };
  }

  const existing = projectMemory.readEntry(entry.name);
  if (existing?.body === entry.body && existing?.description === entry.description) {
    return { written: false, skippedReason: "summary unchanged" };
  }

  // Preserve any user-customised tier/importance (e.g. manual archival decision).
  // lastAccessed + accessCount always refresh to reflect current usage.
  const preservedTier = existing?.tier ?? entry.tier;
  const preservedImportance = existing?.importance ?? entry.importance;
  projectMemory.writeEntry({
    ...entry,
    tier: preservedTier,
    importance: preservedImportance,
  });
  return { written: true };
}

// ---------------------------------------------------------------------------
// Global memory candidate extraction (v2)
// ---------------------------------------------------------------------------

const GLOBAL_SIGNAL_PATTERNS = [
  /\b항상\b/,
  /\b기억\s*해/,
  /\b내\s*선호/,
  /\balways\s+(?:use|prefer|remember)\b/i,
  /\bremember\s+(?:this|that|my)\b/i,
  /\bmy\s+preference\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\bevery\s+(?:time|session)\b/i,
];

/**
 * Check if user messages contain explicit long-term preference signals.
 */
export function hasGlobalMemorySignal(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = getMessageText(msg);
    if (GLOBAL_SIGNAL_PATTERNS.some((p) => p.test(text))) {
      return true;
    }
  }
  return false;
}

export interface GlobalMemoryCandidate {
  name: string;
  type: "preference" | "workflow" | "feedback";
  description: string;
  body: string;
}

/**
 * Extract global memory candidates from a conversation.
 * Only triggers when explicit long-term signals are present.
 * Returns candidates (not auto-saved). Caller decides to save or queue.
 */
export function extractGlobalMemoryCandidates(params: {
  messages: ChatMessage[];
  systemPrompt: string;
  agentDepth: number;
}): GlobalMemoryCandidate[] {
  if (params.agentDepth > 0) return [];

  if (!hasGlobalMemorySignal(params.messages)) return [];

  const candidates: GlobalMemoryCandidate[] = [];
  const highlights = extractHighlights(params.messages);

  for (const highlight of highlights) {
    // Skip if contains sensitive content
    if (detectSensitiveMemoryContent({ body: highlight })) continue;

    // Classify type
    let type: "preference" | "workflow" | "feedback" = "preference";
    if (/\b(?:commit|push|test|dev-plan|branch|deploy)\b/i.test(highlight)) {
      type = "workflow";
    } else if (/\b(?:don't|stop|avoid|instead|better)\b/i.test(highlight)) {
      type = "feedback";
    }

    const name = `global_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    candidates.push({
      name,
      type,
      description: clampText(highlight, 150),
      body: highlight,
    });
  }

  return candidates.slice(0, 3); // max 3 candidates per conversation
}

/**
 * Write global memory candidates if review gate allows.
 * Default: candidates are NOT auto-saved. Set `autoSaveGlobal: true` to save immediately.
 */
export function maybeWriteGlobalMemoryCandidates(params: {
  globalMemory?: GlobalUserMemoryCore;
  messages: ChatMessage[];
  systemPrompt: string;
  agentDepth: number;
  autoSaveGlobal?: boolean;
  cwd?: string;
  projectId?: string;
}): { candidates: GlobalMemoryCandidate[]; saved: number } {
  const candidates = extractGlobalMemoryCandidates({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    agentDepth: params.agentDepth,
  });

  if (candidates.length === 0 || !params.globalMemory) {
    return { candidates, saved: 0 };
  }

  if (!params.autoSaveGlobal) {
    return { candidates, saved: 0 };
  }

  let saved = 0;
  for (const candidate of candidates) {
    try {
      params.globalMemory.writeEntry({
        name: candidate.name,
        type: candidate.type,
        description: candidate.description,
        body: candidate.body,
        createdAt: new Date().toISOString(),
        provenance: {
          source: "auto_summary_candidate",
          cwd: params.cwd,
          projectId: params.projectId,
        },
      });
      saved++;
    } catch {
      // best-effort
    }
  }

  return { candidates, saved };
}
