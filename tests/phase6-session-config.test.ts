/**
 * Phase 6 tests — session storage + config loading.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateSessionId,
  writeSessionHeader,
  appendMessage,
  loadSession,
  listSessions,
} from "../src/session/storage.js";
import { SessionManager } from "../src/session/history.js";
import {
  loadCustomSystemPrompt,
  loadSettings,
  saveSettings,
  resolveDefaultProviderName,
  resolveMaxTurns,
} from "../src/config/loader.js";
import { paths } from "../src/config/paths.js";
import { parseProvidersFile, permissionsFileSchema, settingsFileSchema } from "../src/config/schema.js";
import type { ChatMessage } from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// Session Storage
// ---------------------------------------------------------------------------

describe("Session Storage", () => {
  // Override paths for testing
  let origSessionsDir: string;

  beforeEach(() => {
    // We'll test via the public API which uses paths.sessionsDir
    // For isolated tests, we test the core logic directly
  });

  test("generateSessionId has expected format", () => {
    const id = generateSessionId();
    // Format: YYYYMMDDHHMMSS_8hexchars
    expect(id).toMatch(/^\d{14}_[a-f0-9]{8}$/);
  });

  test("two IDs are unique", () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    expect(id1).not.toBe(id2);
  });
});

describe("Session round-trip (write + read)", () => {
  // Use a temp dir to avoid polluting real config
  let tmpDir: string;
  let originalPaths: typeof import("../src/config/paths.js").paths;

  // We can't easily override paths module, so test at a higher level
  test("SessionManager creates and loads messages", () => {
    const manager = new SessionManager({
      providerName: "test-provider",
      model: "test-model",
    });

    expect(manager.sessionId).toMatch(/^\d{14}_[a-f0-9]{8}$/);

    // Save messages
    const msg1: ChatMessage = { role: "user", content: "hello" };
    const msg2: ChatMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    };

    manager.saveMessage(msg1);
    manager.saveMessage(msg2);

    // Load back
    const loaded = manager.loadMessages();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.role).toBe("user");
    expect(loaded[1]!.role).toBe("assistant");
  });

  test("SessionManager.resolveResumeId handles undefined", () => {
    expect(SessionManager.resolveResumeId(undefined)).toBeUndefined();
  });

  test("SessionManager.resolveResumeId handles specific ID", () => {
    expect(SessionManager.resolveResumeId("my-session-id")).toBe("my-session-id");
  });
});

// ---------------------------------------------------------------------------
// Config Schema
// ---------------------------------------------------------------------------

describe("Config Schema - Providers", () => {
  test("parses valid providers config", () => {
    const data = {
      default: "claude",
      providers: {
        claude: { type: "anthropic", model: "claude-sonnet-4-20250514" },
        local: { type: "openai-compatible", model: "llama3.1", baseUrl: "http://localhost:11434/v1" },
        gpt: { type: "openai", model: "gpt-4o", apiKey: "sk-test" },
      },
    };
    const result = parseProvidersFile(data);
    expect(result.configs).toHaveLength(3);
    expect(result.defaultName).toBe("claude");
  });

  test("parses providers without default", () => {
    const data = {
      providers: {
        local: { type: "openai-compatible", model: "llama3.1", baseUrl: "http://localhost:11434/v1" },
      },
    };
    const result = parseProvidersFile(data);
    expect(result.configs).toHaveLength(1);
    expect(result.defaultName).toBeUndefined();
  });

  test("rejects invalid provider type", () => {
    const data = {
      providers: {
        bad: { type: "invalid-type", model: "test" },
      },
    };
    expect(() => parseProvidersFile(data)).toThrow();
  });

  test("rejects missing model", () => {
    const data = {
      providers: {
        bad: { type: "anthropic" },
      },
    };
    expect(() => parseProvidersFile(data)).toThrow();
  });
});

describe("Config Schema - Permissions", () => {
  test("parses valid permissions config", () => {
    const data = {
      mode: "default",
      rules: [
        { behavior: "allow", toolName: "Bash", pattern: "npm test" },
        { behavior: "deny", toolName: "Bash", pattern: "rm *" },
        { behavior: "ask", toolName: "FileWrite" },
      ],
    };
    const result = permissionsFileSchema.parse(data);
    expect(result.mode).toBe("default");
    expect(result.rules).toHaveLength(3);
  });

  test("uses defaults for empty config", () => {
    const result = permissionsFileSchema.parse({});
    expect(result.mode).toBe("default");
    expect(result.rules).toHaveLength(0);
  });

  test("rejects invalid mode", () => {
    expect(() => permissionsFileSchema.parse({ mode: "yolo" })).toThrow();
  });

  test("rejects invalid behavior", () => {
    expect(() =>
      permissionsFileSchema.parse({
        rules: [{ behavior: "maybe", toolName: "Bash" }],
      }),
    ).toThrow();
  });
});

describe("Config Schema - Settings", () => {
  test("uses defaults for empty config", () => {
    const result = settingsFileSchema.parse({});
    expect(result.theme).toBe("default");
    expect(result.maxTurns).toBe(50);
  });

  test("parses explicit settings", () => {
    const result = settingsFileSchema.parse({
      defaultProvider: "claude",
      theme: "dark",
      maxTurns: 80,
    });
    expect(result.defaultProvider).toBe("claude");
    expect(result.theme).toBe("dark");
    expect(result.maxTurns).toBe(80);
  });
});

describe("Config Loader - Settings wiring", () => {
  let tmpDir: string;
  let originalConfigYml: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coreline-config-"));
    originalConfigYml = paths.configYml;
    (paths as { configYml: string }).configYml = join(tmpDir, "config.yml");
  });

  afterEach(() => {
    (paths as { configYml: string }).configYml = originalConfigYml;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadSettings returns schema defaults when config is missing", () => {
    const result = loadSettings();
    expect(result.defaultProvider).toBeUndefined();
    expect(result.theme).toBe("default");
    expect(result.maxTurns).toBe(50);
  });

  test("saveSettings round-trips through config.yml", () => {
    saveSettings({
      defaultProvider: "claude",
      theme: "dark",
      maxTurns: 77,
    });

    const result = loadSettings();
    expect(result.defaultProvider).toBe("claude");
    expect(result.theme).toBe("dark");
    expect(result.maxTurns).toBe(77);
  });

  test("provider precedence prefers CLI over config.yml over providers default", () => {
    expect(
      resolveDefaultProviderName({
        cliProvider: "cli",
        settingsDefaultProvider: "config",
        providersDefaultName: "providers",
      }),
    ).toBe("cli");

    expect(
      resolveDefaultProviderName({
        settingsDefaultProvider: "config",
        providersDefaultName: "providers",
      }),
    ).toBe("config");

    expect(
      resolveDefaultProviderName({
        providersDefaultName: "providers",
      }),
    ).toBe("providers");
  });

  test("maxTurns prefers CLI override and falls back to settings", () => {
    expect(
      resolveMaxTurns({
        cliMaxTurns: "120",
        settingsMaxTurns: 50,
      }),
    ).toBe(120);

    expect(
      resolveMaxTurns({
        settingsMaxTurns: 75,
      }),
    ).toBe(75);

    expect(
      resolveMaxTurns({
        cliMaxTurns: "not-a-number",
        settingsMaxTurns: 90,
      }),
    ).toBe(90);
  });
});
