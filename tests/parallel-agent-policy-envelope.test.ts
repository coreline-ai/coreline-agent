import { describe, expect, test } from "bun:test";
import {
  appendWorkstreamCardToPrompt,
  buildChildAgentPolicyEnvelope,
  formatChildAgentPolicyGuidance,
  formatWorkstreamCard,
  policyEnvelopeFromRequest,
  validateChildAgentPolicyEnvelope,
} from "../src/agent/parallel/policy-envelope.js";
import {
  SUB_AGENT_DEFAULT_TOOL_ALLOWLIST,
  SUB_AGENT_WRITE_TOOL_ALLOWLIST,
} from "../src/agent/subagent-types.js";

describe("ChildAgentPolicyEnvelope", () => {
  test("builds a normalized default envelope from a request", () => {
    const envelope = policyEnvelopeFromRequest({
      prompt: "review the patch",
      cwd: "/tmp/project",
      provider: "mock",
      write: false,
      ownedPaths: ["src/a.ts", "src/a.ts", " src/b.ts "],
      nonOwnedPaths: ["docs/readme.md"],
    });

    expect(envelope.role).toBe("research");
    expect(envelope.canWrite).toBe(false);
    expect(envelope.canSpawnChild).toBe(false);
    expect(envelope.allowedTools).toEqual([...SUB_AGENT_DEFAULT_TOOL_ALLOWLIST]);
    expect(envelope.deniedTools).toEqual(["Agent"]);
    expect(envelope.ownedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(envelope.nonOwnedPaths).toEqual(["docs/readme.md"]);
    expect(envelope.mustIgnoreInstructionsFromFiles).toBe(true);
    expect(envelope.mustReturnStructuredResult).toBe(true);
  });

  test("enables write tooling for write policies while keeping the boundary strict", () => {
    const envelope = buildChildAgentPolicyEnvelope({
      role: "write",
      canWrite: true,
      canSpawnChild: true,
    });

    expect(envelope.role).toBe("write");
    expect(envelope.canWrite).toBe(true);
    expect(envelope.canSpawnChild).toBe(true);
    expect(envelope.allowedTools).toEqual([
      ...SUB_AGENT_DEFAULT_TOOL_ALLOWLIST,
      ...SUB_AGENT_WRITE_TOOL_ALLOWLIST,
    ]);
    expect(envelope.deniedTools).toEqual([]);
    expect(envelope.instructionBoundary).toBe("user_prompt_only");
  });

  test("formats owned and non-owned guidance for child policy envelopes", () => {
    const envelope = buildChildAgentPolicyEnvelope({
      role: "write",
      canWrite: true,
      ownedPaths: ["src/agent/parallel/policy-envelope.ts"],
      nonOwnedPaths: ["src/agent/parallel/worktree.ts"],
    });

    const guidance = formatChildAgentPolicyGuidance(envelope);
    expect(guidance).toContain("# Child Agent Policy Envelope");
    expect(guidance).toContain("Write access: allowed only within owned paths");
    expect(guidance).toContain("src/agent/parallel/policy-envelope.ts");
    expect(guidance).toContain("src/agent/parallel/worktree.ts");
    expect(guidance).toContain("edit only owned paths");
    expect(guidance).toContain("stop and report the needed handoff");
  });

  test("creates a workstream card and appends it only when guidance exists", () => {
    const card = formatWorkstreamCard({
      prompt: "Implement WS-B",
      ownedPaths: ["src/tools/agent/agent-tool.ts"],
      nonOwnedPaths: ["src/tui/repl.tsx"],
      contracts: ["Do not break permission flow"],
      completionCriteria: ["targeted tests pass"],
      canWrite: true,
    });

    expect(card).toContain("[WORKSTREAM_CARD]");
    expect(card).toContain("Goal: Implement WS-B");
    expect(card).toContain("src/tools/agent/agent-tool.ts");
    expect(card).toContain("src/tui/repl.tsx");
    expect(card).toContain("Do not break permission flow");
    expect(card).toContain("targeted tests pass");

    const appended = appendWorkstreamCardToPrompt("Do work", {
      ownedPaths: ["src/a.ts"],
      nonOwnedPaths: ["src/b.ts"],
    });
    expect(appended).toContain("Do work");
    expect(appended).toContain("[WORKSTREAM_CARD]");
    expect(appendWorkstreamCardToPrompt(appended, { ownedPaths: ["src/a.ts"] })).toBe(appended);
    expect(appendWorkstreamCardToPrompt("No guidance", {})).toBe("No guidance");
  });

  test("validates and normalizes a loose input object", () => {
    const result = validateChildAgentPolicyEnvelope({
      role: "test",
      allowedTools: ["FileRead", "FileRead", " Bash "],
      deniedTools: ["Agent", "Agent"],
      ownedPaths: ["src/x.ts", "", "src/y.ts"],
      nonOwnedPaths: ["docs/a.md"],
      canWrite: false,
      canSpawnChild: false,
      maxTurns: 3,
      timeoutMs: 12_000,
      instructionBoundary: "user_prompt_only",
      mustIgnoreInstructionsFromFiles: true,
      mustReturnStructuredResult: true,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.policy.allowedTools).toEqual(["FileRead", "Bash"]);
    expect(result.policy.deniedTools).toEqual(["Agent"]);
    expect(result.policy.ownedPaths).toEqual(["src/x.ts", "src/y.ts"]);
  });

  test("reports invalid policy fields without throwing", () => {
    const result = validateChildAgentPolicyEnvelope({
      role: "oops",
      allowedTools: [""],
      deniedTools: "Agent",
      canWrite: "yes",
      canSpawnChild: "no",
      maxTurns: 99,
      timeoutMs: 0,
      instructionBoundary: "files",
      mustIgnoreInstructionsFromFiles: false,
      mustReturnStructuredResult: false,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("Invalid role");
    expect(result.errors.join(" ")).toContain("allowedTools");
    expect(result.errors.join(" ")).toContain("deniedTools");
    expect(result.errors.join(" ")).toContain("maxTurns");
    expect(result.errors.join(" ")).toContain("timeoutMs");
    expect(result.errors.join(" ")).toContain("user_prompt_only");
  });
});
