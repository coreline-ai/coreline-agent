import { createHash } from "node:crypto";
import type { ChatMessage } from "./types.js";
import { estimateMessageTokens } from "../utils/token-estimator.js";

const DEFAULT_MARKER_CAP = 100;
const DEFAULT_PROTECT_RECENT_MESSAGES = 4;
const DEFAULT_RESERVED_FOR_RESPONSE = 8_192;
const DEFAULT_MAX_SUMMARY_CHARS = 240;
const SUMMARY_PREFIX = "[Context snip summary:";

export interface SnipRange {
  startIndex: number;
  endIndex: number;
}

export interface SnipMarker extends SnipRange {
  id: string;
  startTurn: number;
  endTurn: number;
  startContentHash: string;
  endContentHash: string;
  createdAt: string;
  priority: number;
  summary?: string;
  reason?: string;
}

export interface SnipPolicy {
  markerCap?: number;
  protectRecentMessages?: number;
  maxSummaryChars?: number;
}

export interface SnipBudget {
  maxTokens: number;
  reservedForResponse?: number;
  systemPromptTokens?: number;
}

export interface SnipApplyResult {
  messages: ChatMessage[];
  appliedMarkerCount: number;
  droppedCount: number;
  compacted: boolean;
  summaryCount: number;
}

export const DEFAULT_SNIP_POLICY: Required<SnipPolicy> = {
  markerCap: DEFAULT_MARKER_CAP,
  protectRecentMessages: DEFAULT_PROTECT_RECENT_MESSAGES,
  maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS,
};

interface NormalizedMarker extends SnipMarker {
  createdAtMs: number;
}

interface AppliedSegment {
  startIndex: number;
  endIndex: number;
  markers: NormalizedMarker[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '"[non-finite]"';
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "undefined") return '"[undefined]"';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hashString(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeContent(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : stableSerialize(content);
}

export function hashChatMessage(message: ChatMessage): string {
  return hashString(stableSerialize({ role: message.role, content: normalizeContent(message.content) }));
}

export function getSnipTurnIndex(messages: readonly ChatMessage[], index: number): number {
  if (index < 0 || index >= messages.length) {
    throw new RangeError(`Message index out of bounds: ${index}`);
  }

  let turn = 0;
  for (let i = 0; i <= index; i += 1) {
    if (messages[i]?.role === "assistant") {
      turn += 1;
    }
  }

  return turn;
}

function normalizePolicy(policy: SnipPolicy = {}): Required<SnipPolicy> {
  return {
    markerCap: Math.max(1, Math.floor(policy.markerCap ?? DEFAULT_SNIP_POLICY.markerCap)),
    protectRecentMessages: Math.max(0, Math.floor(policy.protectRecentMessages ?? DEFAULT_SNIP_POLICY.protectRecentMessages)),
    maxSummaryChars: Math.max(48, Math.floor(policy.maxSummaryChars ?? DEFAULT_SNIP_POLICY.maxSummaryChars)),
  };
}

function normalizeBudget(budget: SnipBudget): Required<SnipBudget> {
  return {
    maxTokens: Math.max(0, Math.floor(budget.maxTokens)),
    reservedForResponse: Math.max(0, Math.floor(budget.reservedForResponse ?? DEFAULT_RESERVED_FOR_RESPONSE)),
    systemPromptTokens: Math.max(0, Math.floor(budget.systemPromptTokens ?? 0)),
  };
}

function parseMarker(marker: SnipMarker, strict: boolean): NormalizedMarker | null {
  if (!marker || typeof marker !== "object") {
    if (strict) throw new Error("Invalid snip marker: expected object");
    return null;
  }

  const {
    id,
    startIndex,
    endIndex,
    startTurn,
    endTurn,
    startContentHash,
    endContentHash,
    createdAt,
    priority,
    summary,
    reason,
  } = marker;

  if (typeof id !== "string" || !id.trim()) {
    if (strict) throw new Error("Invalid snip marker: id is required");
    return null;
  }
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex < startIndex) {
    if (strict) throw new Error(`Invalid snip marker ${id}: invalid range`);
    return null;
  }
  if (!Number.isInteger(startTurn) || !Number.isInteger(endTurn) || startTurn < 0 || endTurn < startTurn) {
    if (strict) throw new Error(`Invalid snip marker ${id}: invalid turn range`);
    return null;
  }
  if (typeof startContentHash !== "string" || !startContentHash.trim() || typeof endContentHash !== "string" || !endContentHash.trim()) {
    if (strict) throw new Error(`Invalid snip marker ${id}: content hashes required`);
    return null;
  }
  if (typeof createdAt !== "string" || !createdAt.trim()) {
    if (strict) throw new Error(`Invalid snip marker ${id}: createdAt is required`);
    return null;
  }

  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) {
    if (strict) throw new Error(`Invalid snip marker ${id}: createdAt must be an ISO timestamp`);
    return null;
  }

  const normalizedPriority = Number.isFinite(priority) ? Math.trunc(priority) : 0;

  return {
    id: id.trim(),
    startIndex,
    endIndex,
    startTurn,
    endTurn,
    startContentHash,
    endContentHash,
    createdAt,
    priority: normalizedPriority,
    summary: typeof summary === "string" && summary.trim() ? summary.trim() : undefined,
    reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
    createdAtMs,
  };
}

function compareMarkersForApplication(a: NormalizedMarker, b: NormalizedMarker): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
  if (a.endIndex !== b.endIndex) return a.endIndex - b.endIndex;
  return a.id.localeCompare(b.id);
}

function compareMarkersForSelection(a: NormalizedMarker, b: NormalizedMarker): number {
  if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
  if (a.endIndex !== b.endIndex) return a.endIndex - b.endIndex;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id.localeCompare(b.id);
}

function overlaps(a: SnipRange, b: SnipRange): boolean {
  return a.startIndex <= b.endIndex && b.startIndex <= a.endIndex;
}

function isSystemMessage(message: ChatMessage): boolean {
  return message.role === "system";
}

function markerMatchesMessages(marker: NormalizedMarker, messages: readonly ChatMessage[]): boolean {
  if (marker.startIndex >= messages.length || marker.endIndex >= messages.length) return false;
  if (marker.startIndex < 0 || marker.endIndex < marker.startIndex) return false;
  if (messages.slice(marker.startIndex, marker.endIndex + 1).some(isSystemMessage)) return false;

  const startMessage = messages[marker.startIndex];
  const endMessage = messages[marker.endIndex];
  if (!startMessage || !endMessage) return false;

  const startTurn = getSnipTurnIndex(messages, marker.startIndex);
  const endTurn = getSnipTurnIndex(messages, marker.endIndex);
  if (startTurn !== marker.startTurn || endTurn !== marker.endTurn) return false;

  const startHash = hashChatMessage(startMessage);
  const endHash = hashChatMessage(endMessage);
  if (startHash !== marker.startContentHash || endHash !== marker.endContentHash) return false;

  return true;
}

function buildSummaryText(segment: AppliedSegment, messages: readonly ChatMessage[], policy: Required<SnipPolicy>): string {
  const removedMessages = messages.slice(segment.startIndex, segment.endIndex + 1);
  const summaryMarker = [...segment.markers].sort(compareMarkersForApplication)[0];
  const primarySummary = summaryMarker?.summary ?? summaryMarker?.reason;
  const turnLabel = segment.startIndex === segment.endIndex
    ? `message ${segment.startIndex + 1}`
    : `messages ${segment.startIndex + 1}-${segment.endIndex + 1}`;
  const base = primarySummary?.trim()
    ? `${primarySummary.trim()} (${removedMessages.length} messages removed from ${turnLabel})`
    : `${removedMessages.length} messages removed from ${turnLabel}`;
  const snipLabel = `[Context snip summary: ${base}]`;
  return snipLabel.length <= policy.maxSummaryChars
    ? snipLabel
    : `${snipLabel.slice(0, policy.maxSummaryChars - 1).trimEnd()}…`;
}

function countSummaryMessages(messages: readonly ChatMessage[]): number {
  return messages.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(SUMMARY_PREFIX)).length;
}

function trimToBudget(messages: readonly ChatMessage[], budget: Required<SnipBudget>): { messages: ChatMessage[]; compacted: boolean } {
  const available = budget.maxTokens - budget.reservedForResponse - budget.systemPromptTokens;
  if (available <= 0) {
    return messages.length <= 2
      ? { messages: [...messages], compacted: false }
      : { messages: messages.slice(-2), compacted: true };
  }
  const kept: ChatMessage[] = [];
  let totalTokens = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    const msgTokens = estimateMessageTokens(msg);
    if (totalTokens + msgTokens > available) {
      break;
    }
    totalTokens += msgTokens;
    kept.unshift(msg);
  }

  if (kept.length === 0 && messages.length > 0) {
    kept.push(messages[messages.length - 1]!);
  }

  return {
    messages: kept,
    compacted: kept.length !== messages.length,
  };
}

function getMarkers(markers: readonly SnipMarker[] | SnipRegistry | undefined): SnipMarker[] {
  if (!markers) return [];
  if (markers instanceof SnipRegistry) return markers.list();
  return [...markers];
}

function insertSegmentSummaries(
  messages: readonly ChatMessage[],
  segments: AppliedSegment[],
  policy: Required<SnipPolicy>,
): { messages: ChatMessage[]; droppedCount: number; summaryCount: number } {
  if (segments.length === 0) {
    return { messages: [...messages], droppedCount: 0, summaryCount: 0 };
  }

  const result: ChatMessage[] = [];
  let cursor = 0;
  let droppedCount = 0;

  for (const segment of segments) {
    if (cursor < segment.startIndex) {
      result.push(...messages.slice(cursor, segment.startIndex));
    }

    const summaryText = buildSummaryText(segment, messages, policy);
    result.push({ role: "user", content: summaryText });

    droppedCount += segment.endIndex - segment.startIndex + 1;
    cursor = segment.endIndex + 1;
  }

  if (cursor < messages.length) {
    result.push(...messages.slice(cursor));
  }

  return { messages: result, droppedCount, summaryCount: segments.length };
}

export class SnipRegistry {
  private readonly policy: Required<SnipPolicy>;
  private markers: NormalizedMarker[] = [];

  constructor(policy: SnipPolicy = {}) {
    this.policy = normalizePolicy(policy);
  }

  get markerCap(): number {
    return this.policy.markerCap;
  }

  add(marker: SnipMarker): SnipMarker {
    const normalized = parseMarker(marker, true);
    if (!normalized) {
      throw new Error("Unable to register snip marker");
    }

    this.markers = [...this.markers, normalized];
    this.pruneToCap();
    return { ...normalized };
  }

  list(): SnipMarker[] {
    return [...this.markers].map((marker) => ({ ...marker }));
  }

  get(id: string): SnipMarker | undefined {
    const found = this.markers.find((marker) => marker.id === id);
    return found ? { ...found } : undefined;
  }

  clear(): void {
    this.markers = [];
  }

  size(): number {
    return this.markers.length;
  }

  private pruneToCap(): void {
    while (this.markers.length > this.policy.markerCap) {
      let victimIndex = 0;
      for (let i = 1; i < this.markers.length; i += 1) {
        const candidate = this.markers[i]!;
        const victim = this.markers[victimIndex]!;
        if (candidate.priority < victim.priority) {
          victimIndex = i;
          continue;
        }
        if (candidate.priority === victim.priority && candidate.createdAtMs < victim.createdAtMs) {
          victimIndex = i;
        }
      }
      this.markers.splice(victimIndex, 1);
    }
  }
}

export function applySnips(
  messages: readonly ChatMessage[],
  markers: readonly SnipMarker[] | SnipRegistry | undefined,
  budget: SnipBudget,
  policy: SnipPolicy = {},
): SnipApplyResult {
  const resolvedPolicy = normalizePolicy(policy);
  const resolvedBudget = normalizeBudget(budget);
  const sourceMarkers = getMarkers(markers);

  if (sourceMarkers.length === 0) {
    return {
      messages: [...messages],
      appliedMarkerCount: 0,
      droppedCount: 0,
      compacted: false,
      summaryCount: 0,
    };
  }

  const protectFromIndex = Math.max(0, messages.length - resolvedPolicy.protectRecentMessages);
  const normalizedMarkers = sourceMarkers
    .map((marker) => parseMarker(marker, false))
    .filter((marker): marker is NormalizedMarker => Boolean(marker))
    .filter((marker) => marker.endIndex < protectFromIndex)
    .filter((marker) => markerMatchesMessages(marker, messages))
    .sort(compareMarkersForApplication);

  const selected: NormalizedMarker[] = [];
  for (const marker of normalizedMarkers) {
    if (selected.some((existing) => overlaps(existing, marker))) {
      continue;
    }
    selected.push(marker);
  }

  if (selected.length === 0) {
    return {
      messages: [...messages],
      appliedMarkerCount: 0,
      droppedCount: 0,
      compacted: false,
      summaryCount: 0,
    };
  }

  const orderedSelections = [...selected].sort(compareMarkersForSelection);
  const mergedSegments: AppliedSegment[] = [];

  for (const marker of orderedSelections) {
    const last = mergedSegments[mergedSegments.length - 1];
    if (last && marker.startIndex <= last.endIndex + 1) {
      last.endIndex = Math.max(last.endIndex, marker.endIndex);
      last.markers.push(marker);
      continue;
    }

    mergedSegments.push({
      startIndex: marker.startIndex,
      endIndex: marker.endIndex,
      markers: [marker],
    });
  }

  const snipped = insertSegmentSummaries(messages, mergedSegments, resolvedPolicy);
  const fallback = trimToBudget(snipped.messages, resolvedBudget);
  const finalMessages = fallback.messages;
  const summaryCount = countSummaryMessages(finalMessages);
  const originalPreservedCount = Math.max(0, finalMessages.length - summaryCount);

  return {
    messages: finalMessages,
    appliedMarkerCount: selected.length,
    droppedCount: messages.length - originalPreservedCount,
    compacted: true,
    summaryCount,
  };
}
