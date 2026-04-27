/**
 * Regression tests for the sub-router refactor of slash-commands.ts.
 * Verifies routing precedence and byte-identical output for usage messages.
 */
import { describe, expect, it } from "bun:test";
import { handleSlashCommand } from "../src/tui/slash-commands.js";

describe("slash-commands sub-router routing", () => {
  it("routes /memory to memory sub-router", () => {
    const result = handleSlashCommand("/memory status");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("memory_status");
  });

  it("routes /fact add to fact sub-router with correct data shape", () => {
    const result = handleSlashCommand("/fact add user.123 name Alice");
    expect(result.handled).toBe(true);
    expect(result.action).toBe("fact");
    expect(result.data).toEqual({
      command: "add",
      entity: "user.123",
      key: "name",
      value: "Alice",
      validFrom: undefined,
      validTo: undefined,
    });
  });

  it("routes /link orphans to link sub-router", () => {
    const result = handleSlashCommand("/link orphans");
    expect(result.action).toBe("link");
    expect(result.data).toEqual({ command: "orphans" });
  });

  it("routes /incident list with flags", () => {
    const result = handleSlashCommand("/incident list --severity high");
    expect(result.action).toBe("incident");
    expect((result.data as { severity?: string }).severity).toBe("high");
  });

  it("routes /decision list and /evidence-first via decision sub-router", () => {
    const dec = handleSlashCommand("/decision list");
    expect(dec.action).toBe("decision");
    const ev = handleSlashCommand("/evidence-first foo bar");
    expect(ev.action).toBe("evidence_first");
    expect((ev.data as { query: string }).query).toBe("foo bar");
  });

  it("routes /runbook and /rca via runbook sub-router", () => {
    const rb = handleSlashCommand("/runbook list");
    expect(rb.action).toBe("runbook");
    const rca = handleSlashCommand("/rca INC-1 --strategy heuristic");
    expect(rca.action).toBe("rca");
    expect(rca.data).toEqual({ incidentId: "INC-1", strategy: "heuristic" });
  });

  it("routes /prompt list to prompt sub-router", () => {
    const result = handleSlashCommand("/prompt list");
    expect(result.action).toBe("prompt_list");
  });

  it("routes /skill stats and /subagent stats via skill sub-router", () => {
    const sk = handleSlashCommand("/skill stats");
    expect(sk.action).toBe("skill");
    expect((sk.data as { command: string }).command).toBe("stats");
    const sa = handleSlashCommand("/subagent stats reviewer");
    expect(sa.action).toBe("subagent_stats");
    expect((sa.data as { value?: string }).value).toBe("reviewer");
  });

  it("routes /search-precise to its sub-router with topK/threshold parsing", () => {
    const result = handleSlashCommand("/search-precise hello world --top-k 5 --threshold 0.7");
    expect(result.action).toBe("search_precise");
    expect(result.data).toEqual({ query: "hello world", topK: 5, threshold: 0.7 });
  });

  it("falls through to 'Unknown command' for unrecognized cmd", () => {
    const result = handleSlashCommand("/this-command-does-not-exist arg1 arg2");
    expect(result.handled).toBe(true);
    expect(result.output).toBe(
      "Unknown command: /this-command-does-not-exist. Type /help for available commands.",
    );
  });

  it("help text includes entries for all sub-router groups", () => {
    const result = handleSlashCommand("/help");
    expect(result.handled).toBe(true);
    const out = result.output ?? "";
    expect(out).toContain("/memory list");
    expect(out).toContain("/fact add");
    expect(out).toContain("/link scan");
    expect(out).toContain("/incident list");
    expect(out).toContain("/decision list");
    expect(out).toContain("/runbook list");
    expect(out).toContain("/evidence-first");
    expect(out).toContain("/rca");
    expect(out).toContain("/prompt save");
    expect(out).toContain("/skill list");
    expect(out).toContain("/subagent stats");
    expect(out).toContain("/search-precise");
  });

  it("preserves byte-identical usage message for /fact (no sub)", () => {
    const result = handleSlashCommand("/fact");
    expect(result.output).toBe("Usage: /fact add|at|history|invalidate|list|keys <entity> ...");
  });

  it("preserves byte-identical usage message for /search-precise (no args)", () => {
    const result = handleSlashCommand("/search-precise");
    expect(result.output).toBe(
      "Usage: /search-precise <query> [--top-k N] [--threshold N]",
    );
  });

  it("non-slash input still returns handled=false", () => {
    const result = handleSlashCommand("hello world");
    expect(result.handled).toBe(false);
  });
});
