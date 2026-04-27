/**
 * Phase 3 smoke tests — permission engine + classifier.
 */

import { describe, test, expect } from "bun:test";
import { PermissionEngine } from "../src/permissions/engine.js";
import { classifyBashCommand } from "../src/permissions/classifier.js";
import type { PermissionCheckContext } from "../src/permissions/types.js";

function makeCtx(rules: PermissionCheckContext["rules"] = []): PermissionCheckContext {
  return { cwd: "/tmp", mode: "default", rules };
}

describe("Bash Classifier", () => {
  test("allows read-only commands", () => {
    expect(classifyBashCommand("ls -la").behavior).toBe("allow");
    expect(classifyBashCommand("cat foo.txt").behavior).toBe("allow");
    expect(classifyBashCommand("git status").behavior).toBe("allow");
    expect(classifyBashCommand("git log --oneline").behavior).toBe("allow");
    expect(classifyBashCommand("grep -rn foo .").behavior).toBe("allow");
    expect(classifyBashCommand("pwd").behavior).toBe("allow");
    expect(classifyBashCommand("echo hello").behavior).toBe("allow");
  });

  test("asks for destructive commands", () => {
    expect(classifyBashCommand("rm -rf /").behavior).toBe("ask");
    expect(classifyBashCommand("git push --force").behavior).toBe("ask");
    expect(classifyBashCommand("git reset --hard").behavior).toBe("ask");
    expect(classifyBashCommand("sudo apt install foo").behavior).toBe("ask");
    expect(classifyBashCommand("git clean -fd").behavior).toBe("ask");
  });

  test("allows safe write commands", () => {
    expect(classifyBashCommand("npm test").behavior).toBe("allow");
    expect(classifyBashCommand("bun test").behavior).toBe("allow");
    expect(classifyBashCommand("npm run build").behavior).toBe("allow");
    expect(classifyBashCommand("git add .").behavior).toBe("allow");
    expect(classifyBashCommand("git commit -m 'msg'").behavior).toBe("allow");
    expect(classifyBashCommand("mkdir -p foo/bar").behavior).toBe("allow");
  });

  test("allows piped read-only chains", () => {
    expect(classifyBashCommand("cat foo.txt | grep bar").behavior).toBe("allow");
    expect(classifyBashCommand("ls | head -5").behavior).toBe("allow");
  });

  test("asks for unknown commands", () => {
    expect(classifyBashCommand("some_random_binary --flag").behavior).toBe("ask");
  });
});

describe("PermissionEngine", () => {
  const engine = new PermissionEngine();

  test("allows read-only tools by default", () => {
    const result = engine.check("FileRead", { file_path: "/tmp/foo.txt" }, makeCtx());
    expect(result.behavior).toBe("allow");
  });

  test("allows MemoryRead by default", () => {
    const result = engine.check("MemoryRead", { name: "user_profile" }, makeCtx());
    expect(result.behavior).toBe("allow");
  });

  test("allows Agent delegation by default without changing write gating", () => {
    const agentResult = engine.check("Agent", { prompt: "review src" }, makeCtx());
    expect(agentResult.behavior).toBe("allow");
    expect(agentResult.reason).toContain("default");

    const writeResult = engine.check("FileWrite", { file_path: "/tmp/foo.txt" }, makeCtx());
    expect(writeResult.behavior).toBe("ask");
  });

  test("asks for write-capable delegated children with stronger guidance", () => {
    const result = engine.check(
      "Agent",
      { prompt: "implement feature", allowedTools: ["FileRead", "FileWrite"] },
      makeCtx(),
    );

    expect(result.behavior).toBe("ask");
    expect(result.reason).toContain("write-capable tools");
    expect(result.reason).toContain("Non-interactive child runs");
  });

  test("asks for write tools by default", () => {
    const result = engine.check("FileWrite", { file_path: "/tmp/foo.txt" }, makeCtx());
    expect(result.behavior).toBe("ask");
  });

  test("asks for MemoryWrite by default (confirmation-gated)", () => {
    const result = engine.check("MemoryWrite", { name: "user_profile" }, makeCtx());
    expect(result.behavior).toBe("ask");
    expect(result.reason).toContain("confirmation");
    expect(result.reason).toContain("Non-interactive child runs");
  });

  test("denies system paths", () => {
    const result = engine.check("FileWrite", { file_path: "/etc/passwd" }, makeCtx());
    expect(result.behavior).toBe("deny");
  });

  test("acceptAll mode allows everything", () => {
    const ctx = makeCtx();
    ctx.mode = "acceptAll";
    const result = engine.check("Bash", { command: "rm -rf /" }, ctx);
    expect(result.behavior).toBe("allow");
  });

  test("denyAll mode denies everything", () => {
    const ctx = makeCtx();
    ctx.mode = "denyAll";
    const result = engine.check("FileRead", { file_path: "/tmp/foo.txt" }, ctx);
    expect(result.behavior).toBe("deny");
  });

  test("custom allow rule matches", () => {
    const ctx = makeCtx([
      { behavior: "allow", toolName: "Bash", pattern: "npm test" },
    ]);
    const result = engine.check("Bash", { command: "npm test" }, ctx);
    expect(result.behavior).toBe("allow");
  });

  test("deny rule overrides allow rule", () => {
    const ctx = makeCtx([
      { behavior: "allow", toolName: "Bash", pattern: "*" },
      { behavior: "deny", toolName: "Bash", pattern: "rm *" },
    ]);
    const result = engine.check("Bash", { command: "rm -rf /" }, ctx);
    expect(result.behavior).toBe("deny");
  });

  test("Agent permission can be overridden by ask and deny rules", () => {
    const askCtx = makeCtx([{ behavior: "ask", toolName: "Agent", pattern: "*" }]);
    const askResult = engine.check("Agent", { prompt: "inspect src" }, askCtx);
    expect(askResult.behavior).toBe("ask");

    const denyCtx = makeCtx([{ behavior: "deny", toolName: "Agent", pattern: "*" }]);
    const denyResult = engine.check("Agent", { prompt: "inspect src" }, denyCtx);
    expect(denyResult.behavior).toBe("deny");
  });

  test("delegates to classifier for unmatched Bash commands", () => {
    const result = engine.check("Bash", { command: "ls -la" }, makeCtx());
    expect(result.behavior).toBe("allow");
  });

  test("unknown tool defaults to deny", () => {
    // Unknown tools are not read-only, not Bash → default ask
    const result = engine.check("UnknownTool", { foo: "bar" }, makeCtx());
    expect(result.behavior).toBe("ask");
  });
});
