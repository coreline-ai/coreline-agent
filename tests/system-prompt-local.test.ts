import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import type { LLMProvider } from "../src/providers/types.js";

function providerOf(type: LLMProvider["type"]): Pick<LLMProvider, "type" | "name" | "model"> {
  return {
    type,
    name: `${type}-provider`,
    model: `${type}-model`,
  };
}

describe("buildSystemPrompt local model hints", () => {
  test("adds a local-model tool-calling section for openai-compatible providers", () => {
    const prompt = buildSystemPrompt(
      process.cwd(),
      [],
      undefined,
      providerOf("openai-compatible"),
    );

    expect(prompt).toContain("# Local Model Tool Calling");
    expect(prompt).toContain('{"name":"Glob","arguments":{"pattern":"**/*","path":"src"}}');
    expect(prompt).toContain('{"name":"NoArgTool","arguments":{}}');
    expect(prompt).toContain("Do not copy the JSON examples literally");
    expect(prompt).toContain("Never invent tool names like EmptyResponse or memory_write");
    expect(prompt).toContain("Do not call MemoryWrite unless the user explicitly asks");
    expect(prompt).toContain("Do not call MemoryRead unless the user asks about saved facts");
    expect(prompt).toContain('use Glob with that directory as "path"');
    expect(prompt).toContain('never substitute "*.ts" or another extension-specific pattern on your own');
  });

  test("keeps the default prompt for anthropic providers", () => {
    const prompt = buildSystemPrompt(
      process.cwd(),
      [],
      undefined,
      providerOf("anthropic"),
    );

    expect(prompt).not.toContain("# Local Model Tool Calling");
  });
});
