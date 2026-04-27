import { describe, expect, test } from "bun:test";
import { buildVerificationPack, verificationPackToReliabilityEvidence } from "../../src/agent/reliability/verification-pack.js";
import type { PlanExecutionResult } from "../../src/agent/plan-execute/runner.js";
import type { PlanRunRecord } from "../../src/session/records.js";
import type { AgentTraceRecord, CompletionDecision } from "../../src/agent/reliability/types.js";
import type { ToolCallResult } from "../../src/tools/orchestration.js";

function successfulPlanExecution(): PlanExecutionResult {
  return {
    plan: {
      goal: "mock single-agent quality smoke",
      tasks: [
        {
          id: "task-1",
          description: "Create deterministic smoke evidence",
          dependsOn: [],
          status: "verified",
          output: {
            summary: "smoke task completed",
            verificationSummary: "unit smoke assertion passed",
            artifacts: [{ kind: "verification", label: "assertion", value: "pack contains evidence" }],
          },
          verification: {
            status: "passed",
            strategy: "deterministic",
            contract: "assertion",
            summary: "Task verified by deterministic assertion",
          },
        },
      ],
    },
    steps: [
      {
        task: {
          id: "task-1",
          description: "Create deterministic smoke evidence",
          dependsOn: [],
          status: "verified",
          verification: {
            status: "passed",
            strategy: "deterministic",
            contract: "assertion",
            summary: "Step verified",
          },
        },
        result: { ok: true },
        output: { verificationSummary: "step output verified" },
        evaluation: {
          success: true,
          outcome: "success",
          strategy: "deterministic",
          contract: "assertion",
          reason: "mock evaluator accepted the task",
        },
      },
    ],
    summary: { completed: 1, failed: 0, ambiguous: 0 },
    completed: true,
  };
}

function successfulPlanRun(): PlanRunRecord {
  return {
    _type: "plan_run",
    planRunId: "plan-run-smoke",
    sessionId: "session-smoke",
    createdAt: "2026-04-19T00:00:00.000Z",
    mode: "autopilot",
    goal: "mock single-agent quality smoke",
    plan: successfulPlanExecution().plan,
    steps: [],
    summary: { completed: 1, failed: 0, ambiguous: 0, verified: 1 },
    completed: true,
    status: "completed",
    resultText: "single-agent smoke completed",
    lastVerificationSummary: "all deterministic evidence passed",
  };
}

function successfulToolResult(): ToolCallResult {
  return {
    toolUseId: "tool-1",
    toolName: "MockTool",
    result: { data: { ok: true } },
    formattedResult: "MockTool completed without external calls",
  };
}

function successfulTrace(): AgentTraceRecord {
  return {
    _type: "agent_trace",
    traceId: "trace-1",
    sessionId: "session-smoke",
    timestamp: "2026-04-19T00:00:01.000Z",
    eventKind: "verification_evidence",
    reason: "mock smoke evidence recorded",
    outcome: "passed",
  };
}

function successfulCompletionDecision(): CompletionDecision {
  return {
    outcome: "completed",
    confidence: "high",
    reason: "all mock evidence passed",
    evidence: [{ kind: "verification", status: "passed", summary: "completion evidence passed" }],
    missingEvidence: [],
  };
}

describe("single-agent quality smoke", () => {
  test("builds a passed verification pack from mock-only evidence", () => {
    const pack = buildVerificationPack({
      packId: "pack-smoke",
      now: "2026-04-19T00:00:02.000Z",
      planExecutionResult: successfulPlanExecution(),
      planRunRecord: successfulPlanRun(),
      toolResults: [successfulToolResult()],
      traces: [successfulTrace()],
      completionDecision: successfulCompletionDecision(),
      externalEvidence: [{ kind: "external", status: "passed", summary: "caller-provided smoke evidence" }],
      requiredEvidenceKinds: ["verification", "evaluation", "tool_result", "plan_run", "trace", "external"],
    });

    expect(pack.packId).toBe("pack-smoke");
    expect(pack.status).toBe("passed");
    expect(pack.missingEvidence).toEqual([]);
    expect(pack.evidence.some((item) => item.kind === "verification")).toBe(true);
    expect(pack.evidence.some((item) => item.kind === "evaluation")).toBe(true);
    expect(pack.evidence.some((item) => item.kind === "tool_result")).toBe(true);
    expect(pack.evidence.some((item) => item.kind === "plan_run")).toBe(true);
    expect(pack.evidence.some((item) => item.kind === "trace")).toBe(true);
    expect(pack.summary).toContain("Verification passed");
  });

  test("marks failed tool evidence as failed without running any tool", () => {
    const pack = buildVerificationPack({
      now: "2026-04-19T00:00:03.000Z",
      toolResults: [{
        toolUseId: "tool-error",
        toolName: "MockTool",
        result: { data: "mock failure", isError: true },
        formattedResult: "mock failure",
      }],
    });

    expect(pack.status).toBe("failed");
    expect(pack.evidence).toHaveLength(1);
    expect(pack.evidence[0]?.summary).toBe("MockTool failed");
  });

  test("reports missing required evidence as ambiguous", () => {
    const pack = buildVerificationPack({
      now: "2026-04-19T00:00:04.000Z",
      externalEvidence: [{ kind: "external", status: "passed", summary: "only external evidence" }],
      requiredEvidenceKinds: ["verification", "tool_result"],
    });

    expect(pack.status).toBe("ambiguous");
    expect(pack.missingEvidence).toEqual(["missing verification evidence", "missing tool_result evidence"]);
  });

  test("can be converted into completion-decision compatible reliability evidence", () => {
    const pack = buildVerificationPack({
      now: "2026-04-19T00:00:05.000Z",
      externalEvidence: [{ kind: "external", status: "passed", summary: "external smoke passed" }],
    });
    const evidence = verificationPackToReliabilityEvidence(pack);

    expect(evidence.kind).toBe("verification");
    expect(evidence.status).toBe("passed");
    expect(evidence.summary).toBe(pack.summary);
  });
});
