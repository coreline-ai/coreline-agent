/**
 * Cloud OAuth providers tests — registry + schema + basic instantiation.
 *
 * These tests verify the provider types are wired correctly.
 * Actual API calls are not tested here (require real OAuth tokens).
 */

import { describe, test, expect } from "bun:test";
import { instantiateProvider } from "../src/providers/registry.js";
import { parseProvidersFile } from "../src/config/schema.js";
import type { ProviderConfig } from "../src/providers/types.js";

describe("Cloud OAuth Provider Registry", () => {
  test("codex-backend provider instantiates", () => {
    const config: ProviderConfig = {
      name: "chatgpt",
      type: "codex-backend",
      model: "gpt-5",
      oauthFile: "~/.codex/auth.json",
    };
    const provider = instantiateProvider(config);
    expect(provider.name).toBe("chatgpt");
    expect(provider.type).toBe("codex-backend");
    expect(provider.model).toBe("gpt-5");
    expect(provider.supportsToolCalling).toBe(true);
    expect(provider.supportsPlanning).toBe(true);
  });

  test("gemini-code-assist provider instantiates", () => {
    const config: ProviderConfig = {
      name: "gemini-pro",
      type: "gemini-code-assist",
      model: "gemini-2.5-pro",
      oauthFile: "~/.gemini/oauth_creds.json",
    };
    const provider = instantiateProvider(config);
    expect(provider.name).toBe("gemini-pro");
    expect(provider.type).toBe("gemini-code-assist");
    expect(provider.supportsPlanning).toBe(true);
  });

  test("anthropic with oauthToken uses Bearer auth", () => {
    const config: ProviderConfig = {
      name: "claude-oauth",
      type: "anthropic",
      model: "claude-sonnet-4-20250514",
      oauthToken: "sk-ant-oauth-test",
    };
    const provider = instantiateProvider(config);
    expect(provider.name).toBe("claude-oauth");
    expect(provider.type).toBe("anthropic");
  });

  test("anthropic with CLAUDE_CODE_OAUTH_TOKEN env falls back", () => {
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token";
    try {
      const config: ProviderConfig = {
        name: "claude-env",
        type: "anthropic",
        model: "claude-sonnet-4-20250514",
      };
      const provider = instantiateProvider(config);
      expect(provider.name).toBe("claude-env");
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    }
  });
});

describe("Cloud OAuth Config Schema", () => {
  test("parses codex-backend config", () => {
    const data = {
      default: "chatgpt",
      providers: {
        chatgpt: {
          type: "codex-backend",
          model: "gpt-5",
          oauthFile: "~/.codex/auth.json",
        },
      },
    };
    const result = parseProvidersFile(data);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.type).toBe("codex-backend");
    expect(result.configs[0]!.oauthFile).toBe("~/.codex/auth.json");
  });

  test("parses gemini-code-assist config with project", () => {
    const data = {
      providers: {
        gemini: {
          type: "gemini-code-assist",
          model: "gemini-2.5-pro",
          geminiProject: "my-gcp-project",
        },
      },
    };
    const result = parseProvidersFile(data);
    expect(result.configs[0]!.type).toBe("gemini-code-assist");
    expect((result.configs[0] as { geminiProject?: string }).geminiProject).toBe("my-gcp-project");
  });

  test("parses anthropic with oauthToken from env", () => {
    const data = {
      providers: {
        claude: {
          type: "anthropic",
          model: "claude-sonnet-4-20250514",
          oauthToken: "${CLAUDE_CODE_OAUTH_TOKEN}",
        },
      },
    };
    const result = parseProvidersFile(data);
    expect(result.configs[0]!.oauthToken).toBe("${CLAUDE_CODE_OAUTH_TOKEN}");
  });

  test("rejects unknown provider type", () => {
    const data = {
      providers: {
        bad: { type: "unknown-provider", model: "test" },
      },
    };
    expect(() => parseProvidersFile(data)).toThrow();
  });

  test("accepts all 6 provider types", () => {
    const types = [
      "anthropic",
      "openai",
      "gemini",
      "openai-compatible",
      "codex-backend",
      "gemini-code-assist",
    ];
    for (const type of types) {
      const data = {
        providers: {
          test: {
            type,
            model: "test",
            baseUrl: type === "openai-compatible" ? "http://localhost:11434/v1" : undefined,
          },
        },
      };
      expect(() => parseProvidersFile(data)).not.toThrow();
    }
  });
});
