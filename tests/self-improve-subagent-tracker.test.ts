/**
 * Tests for subagent-tracker — recordSubagentRun + extractSubagentType.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSubagentType,
  recordSubagentRun,
} from "../src/agent/self-improve/subagent-tracker.js";
import { readEvidence } from "../src/agent/self-improve/evidence.js";
import { getSubagentEvidenceDir } from "../src/config/paths.js";

let tempRoot: string;
const PROJECT_ID = "proj-subagent-tracker-test";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "subagent-tracker-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("recordSubagentRun", () => {
  test("single recordSubagentRun → 1 JSONL line with schema", () => {
    const result = recordSubagentRun(
      PROJECT_ID,
      {
        subagentType: "Explore",
        parentSessionId: "s-1",
        agentDepth: 1,
        outcome: { success: true, turnsUsed: 4, toolCalls: 3 },
      },
      tempRoot,
    );
    expect(result.recorded).toBe(true);

    const path = join(getSubagentEvidenceDir(PROJECT_ID, tempRoot), "Explore.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.domain).toBe("subagent");
    expect(parsed.id).toBe("Explore");
    expect(parsed.iteration).toBe(1);
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.outcome.success).toBe(true);
    expect(parsed.outcome.turnsUsed).toBe(4);
    expect(parsed.metadata?.agentDepth).toBe(1);
    expect(typeof parsed.invokedAt).toBe("string");
  });

  test("two calls with different subagentType → two records, per-record agentDepth preserved", () => {
    const r1 = recordSubagentRun(
      PROJECT_ID,
      {
        subagentType: "Explore",
        parentSessionId: "s-x",
        agentDepth: 1,
        outcome: { success: true },
      },
      tempRoot,
    );
    const r2 = recordSubagentRun(
      PROJECT_ID,
      {
        subagentType: "Plan",
        parentSessionId: "s-x",
        agentDepth: 2,
        outcome: { success: true },
      },
      tempRoot,
    );
    expect(r1.recorded).toBe(true);
    expect(r2.recorded).toBe(true);

    const explore = readEvidence(PROJECT_ID, "subagent", "Explore", {}, tempRoot);
    const plan = readEvidence(PROJECT_ID, "subagent", "Plan", {}, tempRoot);
    expect(explore).toHaveLength(1);
    expect(plan).toHaveLength(1);
    expect(explore[0]!.metadata?.agentDepth).toBe(1);
    expect(plan[0]!.metadata?.agentDepth).toBe(2);
    expect(explore[0]!.iteration).toBe(1);
    expect(plan[0]!.iteration).toBe(1);
  });

  test("aborted run: success=false and metadata.reason=\"aborted\"", () => {
    const res = recordSubagentRun(
      PROJECT_ID,
      {
        subagentType: "Explore",
        parentSessionId: "s-ab",
        agentDepth: 1,
        outcome: { success: false, turnsUsed: 1 },
        metadata: { reason: "aborted" },
      },
      tempRoot,
    );
    expect(res.recorded).toBe(true);

    const records = readEvidence(PROJECT_ID, "subagent", "Explore", {}, tempRoot);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome.success).toBe(false);
    expect(records[0]!.metadata?.reason).toBe("aborted");
  });

  test("failure-style record with success:false still appends", () => {
    // Simulates what persistSubAgentRuns does in its try/catch wrapper:
    // even if the underlying agent tool threw, a failure record can be written.
    const res = recordSubagentRun(
      PROJECT_ID,
      {
        subagentType: "Explore",
        parentSessionId: "s-fail",
        agentDepth: 1,
        outcome: { success: false },
        metadata: { partial: true, failedCount: 1 },
      },
      tempRoot,
    );
    expect(res.recorded).toBe(true);
    const records = readEvidence(PROJECT_ID, "subagent", "Explore", {}, tempRoot);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome.success).toBe(false);
    expect(records[0]!.metadata?.partial).toBe(true);
    expect(records[0]!.metadata?.failedCount).toBe(1);
  });

  test("iteration auto-increments across repeated calls for the same type", () => {
    for (let i = 0; i < 3; i += 1) {
      recordSubagentRun(
        PROJECT_ID,
        {
          subagentType: "Explore",
          parentSessionId: `s-${i}`,
          agentDepth: 1,
          outcome: { success: true },
        },
        tempRoot,
      );
    }
    const records = readEvidence(PROJECT_ID, "subagent", "Explore", {}, tempRoot);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.iteration)).toEqual([1, 2, 3]);
  });

  test("empty projectId returns {recorded:false}", () => {
    const res = recordSubagentRun(
      "",
      {
        subagentType: "Explore",
        parentSessionId: "s",
        agentDepth: 1,
        outcome: { success: true },
      },
      tempRoot,
    );
    expect(res.recorded).toBe(false);
    expect(res.error).toBeDefined();
  });
});

describe("extractSubagentType", () => {
  test("bracketed prefix returns captured name", () => {
    expect(extractSubagentType("[Explore] find auth flow")).toBe("Explore");
    expect(extractSubagentType("[Plan] design migration steps")).toBe("Plan");
    expect(extractSubagentType("[Code-Review] review PR #42")).toBe("Code-Review");
  });

  test("no bracket: returns trimmed prefix up to 40 chars", () => {
    expect(extractSubagentType("no bracket prompt")).toBe("no bracket prompt");
    const long = "This is a fairly long delegation prompt that easily exceeds forty characters in total length.";
    const out = extractSubagentType(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(long.startsWith(out)).toBe(true);
  });

  test("empty / whitespace returns 'unspecified'", () => {
    expect(extractSubagentType("")).toBe("unspecified");
    expect(extractSubagentType("   \n\t  ")).toBe("unspecified");
  });

  test("leading whitespace is tolerated for bracket detection", () => {
    expect(extractSubagentType("   [Explore] trimmed start")).toBe("Explore");
  });
});
