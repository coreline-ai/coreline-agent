import type { AgentStatusSnapshot } from "../../agent/status.js";
import {
  validateClideckTaskResult,
  type ClideckAgentEvent,
  type ClideckAgentState,
  type ClideckTaskResult,
  type CorelineArtifact,
} from "../../proxy/platform-types.js";

export function statusToClideckEvent(snapshot: AgentStatusSnapshot, now: () => Date = () => new Date()): ClideckAgentEvent {
  const event: ClideckAgentEvent = {
    type: "clideck_agent_event",
    agent: "coreline-agent",
    state: statusToClideckState(snapshot.status),
    timestamp: now().toISOString(),
    sessionId: snapshot.sessionId,
    provider: snapshot.provider,
    model: snapshot.model,
    cwd: snapshot.cwd,
    message: snapshot.message,
    rawStatus: snapshot,
  };
  return compact(event);
}

export function statusToClideckState(status: AgentStatusSnapshot["status"]): ClideckAgentState {
  switch (status) {
    case "idle":
      return "idle";
    case "planning":
    case "running":
      return "working";
    case "blocked":
      return "blocked";
    case "needs_user":
      return "waiting_user";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "exited":
      return "offline";
    default:
      return "offline";
  }
}

export function clideckResultToArtifact(value: unknown): CorelineArtifact | null {
  if (!validateClideckTaskResult(value)) return null;
  return buildArtifact(value);
}

export function buildArtifact(result: ClideckTaskResult): CorelineArtifact {
  const content = [
    result.summary,
    ...(result.artifacts ?? []).map(formatArtifactLine),
  ].filter(Boolean).join("\n");

  const artifact: CorelineArtifact = {
    type: "coreline_artifact",
    source: "clideck",
    taskId: result.taskId,
    status: result.status,
    title: `clideck task ${result.taskId} ${result.status}`,
    content: content || `clideck task ${result.taskId} ${result.status}`,
    metadata: result.metadata,
  };
  return compact(artifact);
}

function formatArtifactLine(artifact: NonNullable<ClideckTaskResult["artifacts"]>[number]): string {
  if (artifact.kind === "file") return `[file] ${artifact.name}: ${artifact.path ?? ""}`.trim();
  if (artifact.kind === "url") return `[url] ${artifact.name}: ${artifact.url ?? ""}`.trim();
  if (artifact.kind === "json") return `[json] ${artifact.name}: ${JSON.stringify(artifact.data ?? null)}`;
  return `[text] ${artifact.name}: ${artifact.content ?? ""}`.trim();
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
