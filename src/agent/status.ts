/**
 * Agent status snapshots for external observers such as clideck.
 *
 * The status file is intentionally small and JSON-only so other local tools can
 * read it without linking against coreline-agent internals.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config/paths.js";
import type {
  ProviderQuotaMetadata,
  ProviderRateLimitMetadata,
  ProviderRuntimeMetadata,
} from "../providers/types.js";

export type AgentStatus =
  | "idle"
  | "planning"
  | "running"
  | "blocked"
  | "needs_user"
  | "completed"
  | "failed"
  | "aborted"
  | "exited";

export type AgentMode = "chat" | "plan" | "goal" | "autopilot" | "proxy";

export interface AgentCostStatusMetadata {
  totalCost?: number;
  budget?: number;
  overBudget?: boolean;
  hasUnknownPricing?: boolean;
  unknownModels?: string[];
}

export interface AgentStatuslinePreview {
  valid: boolean;
  wouldExecute: false;
  command?: string;
  preview?: string;
  reason?: string;
}

export interface AgentStatusSnapshot {
  status: AgentStatus;
  mode?: AgentMode;
  sessionId?: string;
  provider?: string;
  model?: string;
  providerMetadata?: ProviderRuntimeMetadata;
  cost?: AgentCostStatusMetadata;
  quota?: ProviderQuotaMetadata;
  rateLimit?: ProviderRateLimitMetadata;
  statusline?: AgentStatuslinePreview;
  turn?: number;
  lastActivity: string;
  pid: number;
  startedAt: string;
  uptimeMs: number;
  cwd?: string;
  message?: string;
  resumeEligible?: boolean;
}

export type AgentStatusPatch = Partial<Omit<AgentStatusSnapshot, "lastActivity" | "pid" | "startedAt" | "uptimeMs">> & {
  status?: AgentStatus;
};

export type StatusListener = (snapshot: AgentStatusSnapshot) => void;
export type StatusHookDispatcher = (snapshot: AgentStatusSnapshot, previous?: AgentStatusSnapshot) => void | Promise<unknown>;

export interface StatusTrackerOptions {
  statusPath?: string;
  initial?: AgentStatusPatch;
  now?: () => Date;
  hookDispatcher?: StatusHookDispatcher;
}

export class StatusTracker {
  readonly statusPath: string;

  private readonly startedAtDate: Date;
  private readonly now: () => Date;
  private snapshot: AgentStatusSnapshot;
  private readonly listeners = new Set<StatusListener>();
  private readonly hookDispatcher?: StatusHookDispatcher;

  constructor(options: StatusTrackerOptions = {}) {
    this.statusPath = options.statusPath ?? paths.statusJson;
    this.now = options.now ?? (() => new Date());
    this.hookDispatcher = options.hookDispatcher;
    this.startedAtDate = this.now();
    const base: AgentStatusSnapshot = {
      status: options.initial?.status ?? "idle",
      mode: options.initial?.mode,
      sessionId: options.initial?.sessionId,
      provider: options.initial?.provider,
      model: options.initial?.model,
      providerMetadata: options.initial?.providerMetadata,
      cost: options.initial?.cost,
      quota: options.initial?.quota,
      rateLimit: options.initial?.rateLimit,
      statusline: options.initial?.statusline,
      turn: options.initial?.turn,
      cwd: options.initial?.cwd,
      message: options.initial?.message,
      resumeEligible: options.initial?.resumeEligible,
      lastActivity: this.startedAtDate.toISOString(),
      pid: process.pid,
      startedAt: this.startedAtDate.toISOString(),
      uptimeMs: 0,
    };
    this.snapshot = compactSnapshot(base);
  }

  update(statusOrPatch: AgentStatus | AgentStatusPatch, metadata: AgentStatusPatch = {}): AgentStatusSnapshot {
    const patch = typeof statusOrPatch === "string"
      ? { ...metadata, status: statusOrPatch }
      : { ...statusOrPatch };
    const now = this.now();
    const previous = this.get();
    this.snapshot = compactSnapshot({
      ...this.snapshot,
      ...patch,
      lastActivity: now.toISOString(),
      pid: process.pid,
      startedAt: this.startedAtDate.toISOString(),
      uptimeMs: Math.max(0, now.getTime() - this.startedAtDate.getTime()),
    });
    this.write();
    this.emit(previous);
    return this.get();
  }

  get(): AgentStatusSnapshot {
    const now = this.now();
    return compactSnapshot({
      ...this.snapshot,
      pid: process.pid,
      uptimeMs: Math.max(0, now.getTime() - this.startedAtDate.getTime()),
    });
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(): void {
    writeStatusSnapshot(this.statusPath, this.snapshot);
  }

  close(status: AgentStatus = "exited", message = "process exited"): AgentStatusSnapshot {
    return this.update({ status, message });
  }

  clear(): void {
    try {
      rmSync(this.statusPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  private emit(previous?: AgentStatusSnapshot): void {
    const snapshot = this.get();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    if (this.hookDispatcher) {
      Promise.resolve(this.hookDispatcher(snapshot, previous)).catch(() => {
        // Hook dispatch is observational and must never break status updates.
      });
    }
  }
}

export function writeStatusSnapshot(statusPath: string, snapshot: AgentStatusSnapshot): void {
  const dir = dirname(statusPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(compactSnapshot(snapshot), null, 2)}\n`, "utf8");
  renameSync(tmp, statusPath);
}

export function readStatusSnapshot(statusPath: string = paths.statusJson): AgentStatusSnapshot | null {
  try {
    const raw = readFileSync(statusPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStatusSnapshot(parsed);
  } catch {
    return null;
  }
}

export function normalizeStatusSnapshot(value: unknown): AgentStatusSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const status = normalizeStatus(rec.status);
  if (!status) return null;
  const now = new Date().toISOString();
  return compactSnapshot({
    status,
    mode: normalizeMode(rec.mode),
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
    provider: typeof rec.provider === "string" ? rec.provider : undefined,
    model: typeof rec.model === "string" ? rec.model : undefined,
    providerMetadata: sanitizeJsonRecord(rec.providerMetadata) as ProviderRuntimeMetadata | undefined,
    cost: sanitizeJsonRecord(rec.cost) as AgentCostStatusMetadata | undefined,
    quota: sanitizeJsonRecord(rec.quota) as ProviderQuotaMetadata | undefined,
    rateLimit: sanitizeJsonRecord(rec.rateLimit) as ProviderRateLimitMetadata | undefined,
    statusline: sanitizeJsonRecord(rec.statusline) as AgentStatuslinePreview | undefined,
    turn: typeof rec.turn === "number" && Number.isFinite(rec.turn) ? rec.turn : undefined,
    lastActivity: typeof rec.lastActivity === "string" ? rec.lastActivity : now,
    pid: typeof rec.pid === "number" && Number.isFinite(rec.pid) ? rec.pid : 0,
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : now,
    uptimeMs: typeof rec.uptimeMs === "number" && Number.isFinite(rec.uptimeMs) ? rec.uptimeMs : 0,
    cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
    message: typeof rec.message === "string" ? rec.message : undefined,
    resumeEligible: typeof rec.resumeEligible === "boolean" ? rec.resumeEligible : undefined,
  });
}

export function formatAgentStatusLabel(snapshot?: Pick<AgentStatusSnapshot, "status" | "mode"> | null): string | null {
  if (!snapshot) return null;
  return snapshot.mode ? `${snapshot.mode}:${snapshot.status}` : snapshot.status;
}

function normalizeStatus(value: unknown): AgentStatus | undefined {
  switch (value) {
    case "idle":
    case "planning":
    case "running":
    case "blocked":
    case "needs_user":
    case "completed":
    case "failed":
    case "aborted":
    case "exited":
      return value;
    case "working":
      return "running";
    case "waiting_user":
      return "needs_user";
    default:
      return undefined;
  }
}

function normalizeMode(value: unknown): AgentMode | undefined {
  switch (value) {
    case "chat":
    case "plan":
    case "goal":
    case "autopilot":
    case "proxy":
      return value;
    default:
      return undefined;
  }
}

function compactSnapshot(snapshot: AgentStatusSnapshot): AgentStatusSnapshot {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined),
  ) as AgentStatusSnapshot;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) return undefined;
    return value
      .map((entry) => sanitizeJsonValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (isPlainRecord(value)) {
    return sanitizeJsonRecord(value, depth + 1);
  }
  return undefined;
}

function sanitizeJsonRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || depth > 4) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|api[-_]?key|authorization|password/i.test(key)) continue;
    const sanitized = sanitizeJsonValue(entry, depth);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
