/**
 * Session History — manages session lifecycle for the REPL.
 */

import type { ChatMessage } from "../agent/types.js";
import {
  generateSessionId,
  writeSessionHeader,
  appendMessage,
  appendTranscriptEntries,
  loadSession,
  appendSubAgentRunRecord,
  loadSubAgentRuns,
  appendPlanRunRecord,
  loadPlanRuns,
  loadLatestResumablePlanRun,
  getLatestSessionId,
} from "./storage.js";
import type { PlanRunRecord, SubAgentRunRecord } from "./records.js";
import { normalizeMessage } from "./transcript.js";

export class SessionManager {
  readonly sessionId: string;
  private providerName: string;
  private model: string;
  private recordChildExecutions: boolean;
  private transcriptTurnIndex = 0;
  private readonly transcriptToolNames = new Map<string, string>();

  constructor(opts: { resumeSessionId?: string; providerName: string; model: string; recordChildExecutions?: boolean }) {
    this.providerName = opts.providerName;
    this.model = opts.model;
    this.recordChildExecutions = opts.recordChildExecutions ?? true;

    if (opts.resumeSessionId) {
      this.sessionId = opts.resumeSessionId;
    } else {
      this.sessionId = generateSessionId();
      writeSessionHeader(this.sessionId, {
        provider: opts.providerName,
        model: opts.model,
        cwd: process.cwd(),
      });
    }

    this.transcriptTurnIndex = loadSession(this.sessionId)?.messages.length ?? 0;
  }

  /** Load existing messages if resuming */
  loadMessages(): ChatMessage[] {
    const data = loadSession(this.sessionId);
    return data?.messages ?? [];
  }

  /** Persist a message */
  saveMessage(message: ChatMessage): void {
    appendMessage(this.sessionId, message);
    appendTranscriptEntries(
      this.sessionId,
      normalizeMessage(message, this.transcriptTurnIndex, {
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        toolNameById: this.transcriptToolNames,
      }),
    );
    this.transcriptTurnIndex += 1;
  }

  /** Persist a sub-agent run debug record, when enabled */
  saveSubAgentRun(record: Omit<SubAgentRunRecord, "_type" | "sessionId" | "createdAt" | "childId"> & {
    childId?: string;
    id?: string;
    sessionId?: string;
    createdAt?: string;
  }): void {
    if (!this.recordChildExecutions) return;
    appendSubAgentRunRecord(this.sessionId, record);
  }

  /** Backward-compatible alias */
  saveChildExecution(record: Omit<SubAgentRunRecord, "_type" | "sessionId" | "createdAt" | "childId"> & {
    childId?: string;
    id?: string;
    sessionId?: string;
    createdAt?: string;
  }): void {
    this.saveSubAgentRun(record);
  }

  /** Load sub-agent run debug records for the current session */
  loadSubAgentRuns(): SubAgentRunRecord[] {
    return loadSubAgentRuns(this.sessionId);
  }

  /** Persist a plan run record */
  savePlanRun(record: Omit<PlanRunRecord, "_type" | "sessionId" | "createdAt" | "planRunId"> & {
    planRunId?: string;
    id?: string;
    sessionId?: string;
    createdAt?: string;
  }): void {
    appendPlanRunRecord(this.sessionId, record);
  }

  /** Load plan run records for the current session */
  loadPlanRuns(): PlanRunRecord[] {
    return loadPlanRuns(this.sessionId);
  }

  /** Load the latest resumable goal/plan run, if any */
  loadLatestResumablePlanRun(): PlanRunRecord | null {
    return loadLatestResumablePlanRun(this.sessionId);
  }

  /** Backward-compatible alias */
  loadChildExecutionRecords(): SubAgentRunRecord[] {
    return this.loadSubAgentRuns();
  }

  /** Resolve --resume flag: true → latest, string → specific ID */
  static resolveResumeId(flag: string | true | undefined): string | undefined {
    if (flag === undefined) return undefined;
    if (flag === true) {
      return getLatestSessionId() ?? undefined;
    }
    return flag;
  }
}
