import { describe, expect, test } from "bun:test";
import {
  normalizeParallelAgentResult,
  parseParallelAgentResultText,
  stripMarkdownCodeFences,
} from "../src/agent/parallel/structured-result.js";

describe("ParallelAgent structured result parser", () => {
  test("strips markdown fences and parses the full structured payload", () => {
    const payload = stripMarkdownCodeFences(
      "```json\n" +
        '{\n' +
        '  "status": "completed",\n' +
        '  "summary": "done",\n' +
        '  "changedFiles": ["src/a.ts", "src/a.ts"],\n' +
        '  "readFiles": ["src/a.ts"],\n' +
        '  "commandsRun": ["bun test"],\n' +
        '  "testsRun": [\n' +
        '    { "command": "bun test", "status": "pass", "outputSummary": "ok" }\n' +
        '  ],\n' +
        '  "risks": ["none"],\n' +
        '  "nextActions": ["ship it"]\n' +
        '}\n' +
        "```",
    );

    const result = normalizeParallelAgentResult(payload);
    expect(result.kind).toBe("structured");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("done");
    expect(result.finalText).toBe("done");
    expect(result.structuredResult?.changedFiles).toEqual(["src/a.ts"]);
    expect(result.structuredResult?.testsRun[0]?.command).toBe("bun test");
  });

  test("accepts the minimal status+summary payload", () => {
    const result = parseParallelAgentResultText(
      "```json\n{" +
        '"status":"partial","summary":"needs follow-up"' +
        "}\n```",
      "fallback text",
    );

    expect(result.kind).toBe("minimal");
    expect(result.status).toBe("partial");
    expect(result.summary).toBe("needs follow-up");
    expect(result.finalText).toBe("fallback text");
    expect(result.minimalResult).toEqual({ status: "partial", summary: "needs follow-up" });
  });

  test("falls back to final text when the payload is not JSON", () => {
    const result = normalizeParallelAgentResult("plain assistant output", "final fallback text");

    expect(result.kind).toBe("fallback");
    expect(result.status).toBe("partial");
    expect(result.summary).toBe("final fallback text");
    expect(result.finalText).toBe("final fallback text");
    expect(result.errors.join(" ")).toContain("not valid JSON");
  });

  test("uses failed fallback when there is no usable text", () => {
    const result = normalizeParallelAgentResult("{ not json }", "");

    expect(result.kind).toBe("fallback");
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("(no summary)");
    expect(result.finalText).toBe("");
  });
});
