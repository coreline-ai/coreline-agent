import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackendProvider } from "../src/providers/codex-backend.js";
import {
  getCodexAuthSearchPaths,
  getValidCodexTokens,
  readCodexAuthFile,
  readCodexConfig,
} from "../src/providers/codex-auth.js";
import type { ProviderConfig } from "../src/providers/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-codex-auth-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    const result = fn();
    if (
      typeof result === "object" &&
      result !== null &&
      "finally" in result &&
      typeof result.finally === "function"
    ) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex auth/config reader", () => {
  test("CODEX_CONFIG_PATH overrides config.toml and parses model strings", () => {
    const dir = makeTempDir();
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      [
        'model = "gpt-5-codex"',
        'model_reasoning_effort = "high" # top-level string',
        "",
        "[profiles.default]",
        'model = "ignored-profile-model"',
      ].join("\n"),
      "utf-8",
    );

    withEnv({ CODEX_CONFIG_PATH: configPath }, () => {
      const config = readCodexConfig();
      expect(config.filePath).toBe(configPath);
      expect(config.model).toBe("gpt-5-codex");
      expect(config.modelReasoningEffort).toBe("high");
      expect(config.model_reasoning_effort).toBe("high");
    });
  });

  test("provider config model wins over config.toml model", () => {
    const dir = makeTempDir();
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      ['model = "gpt-5-codex"', 'model_reasoning_effort = "medium"'].join("\n"),
      "utf-8",
    );

    withEnv({ CODEX_CONFIG_PATH: configPath }, () => {
      const provider = new CodexBackendProvider({
        name: "codex",
        type: "codex-backend",
        model: "provider-model",
      });

      expect(provider.model).toBe("provider-model");
      expect(provider.modelReasoningEffort).toBe("medium");
      expect(provider.getMetadata().modelSource).toBe("provider-config");
      expect(provider.getMetadata().config?.configPath).toBe(configPath);
      expect(provider.getMetadata().config?.model).toBe("gpt-5-codex");
      expect(provider.getMetadata().config?.reasoningEffort).toBe("medium");
    });
  });

  test("config.toml model is a fallback when provider model is blank", () => {
    const dir = makeTempDir();
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5-codex"\n', "utf-8");

    withEnv({ CODEX_CONFIG_PATH: configPath }, () => {
      const provider = new CodexBackendProvider({
        name: "codex",
        type: "codex-backend",
        model: "",
      } as ProviderConfig);

      expect(provider.model).toBe("gpt-5-codex");
      expect(provider.getMetadata().modelDisplayName).toBe("GPT-5 Codex");
      expect(provider.getMetadata().modelSource).toBe("codex-config");
    });
  });

  test("captures Codex quota and rate-limit response headers as optional metadata", async () => {
    const dir = makeTempDir();
    const authPath = join(dir, "auth.json");
    writeJson(authPath, {
      access_token: "access",
      refresh_token: "refresh",
      chatgpt_account_id: "acct",
      expires_at: Date.now() + 60 * 60 * 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          "event: response.completed",
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
          "",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: {
            "x-ratelimit-limit-requests": "100",
            "x-ratelimit-remaining-requests": "99",
            "x-ratelimit-reset-requests": "1s",
            "x-quota-remaining": "42",
            "x-quota-limit": "1000",
          },
        },
      );

    try {
      await withEnv({ CODEX_AUTH_PATH: authPath }, async () => {
        const provider = new CodexBackendProvider({
          name: "codex",
          type: "codex-backend",
          model: "gpt-5-codex",
        });
        const chunks = [];
        for await (const chunk of provider.send({
          messages: [{ role: "user", content: "hello" }],
        })) {
          chunks.push(chunk);
        }

        const done = chunks.find((chunk) => chunk.type === "done");
        expect(done?.metadata?.rateLimit?.remainingRequests).toBe(99);
        expect(done?.metadata?.quota?.remaining).toBe(42);
        expect(provider.getMetadata().rateLimit?.limitRequests).toBe(100);
        expect(provider.getMetadata().quota?.limit).toBe(1000);
        expect(provider.getMetadata().config?.authPath).toBe(authPath);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("CODEX_AUTH_PATH is searched after explicit oauthFile and before defaults", () => {
    const dir = makeTempDir();
    const envAuthPath = join(dir, "env-auth.json");
    const explicitAuthPath = join(dir, "explicit-auth.json");

    withEnv({ CODEX_AUTH_PATH: envAuthPath }, () => {
      const paths = getCodexAuthSearchPaths(explicitAuthPath);
      expect(paths[0]).toBe(explicitAuthPath);
      expect(paths[1]).toBe(envAuthPath);
    });
  });

  test("CODEX_AUTH_PATH can supply proxy-format OAuth tokens", async () => {
    const dir = makeTempDir();
    const envAuthPath = join(dir, "env-auth.json");
    writeJson(envAuthPath, {
      access_token: "env-access",
      refresh_token: "env-refresh",
      chatgpt_account_id: "acct-env",
      expires_at: Date.now() + 60 * 60 * 1000,
    });

    await withEnv({ CODEX_AUTH_PATH: envAuthPath }, async () => {
      const tokens = await getValidCodexTokens();
      expect(tokens.accessToken).toBe("env-access");
      expect(tokens.refreshToken).toBe("env-refresh");
      expect(tokens.accountId).toBe("acct-env");
      expect(tokens.filePath).toBe(envAuthPath);
    });
  });

  test("explicit oauthFile has priority over CODEX_AUTH_PATH", async () => {
    const dir = makeTempDir();
    const envAuthPath = join(dir, "env-auth.json");
    const explicitAuthPath = join(dir, "explicit-auth.json");
    const futureExpiry = Date.now() + 60 * 60 * 1000;

    writeJson(envAuthPath, {
      access_token: "env-access",
      refresh_token: "env-refresh",
      chatgpt_account_id: "acct-env",
      expires_at: futureExpiry,
    });
    writeJson(explicitAuthPath, {
      access_token: "explicit-access",
      refresh_token: "explicit-refresh",
      chatgpt_account_id: "acct-explicit",
      expires_at: futureExpiry,
    });

    await withEnv({ CODEX_AUTH_PATH: envAuthPath }, async () => {
      const tokens = await getValidCodexTokens(explicitAuthPath);
      expect(tokens.accessToken).toBe("explicit-access");
      expect(tokens.refreshToken).toBe("explicit-refresh");
      expect(tokens.accountId).toBe("acct-explicit");
      expect(tokens.filePath).toBe(explicitAuthPath);
    });
  });

  test("reads Codex CLI token shape and safely handles API-key-only auth shape", () => {
    const dir = makeTempDir();
    const cliAuthPath = join(dir, "codex-cli-auth.json");
    const apiKeyOnlyPath = join(dir, "api-key-only-auth.json");

    writeJson(cliAuthPath, {
      OPENAI_API_KEY: "sk-test",
      tokens: {
        access_token: "cli-access",
        refresh_token: "cli-refresh",
        account_id: "acct-cli",
      },
    });
    writeJson(apiKeyOnlyPath, {
      OPENAI_API_KEY: "sk-test",
    });

    const cliAuth = readCodexAuthFile(cliAuthPath);
    expect(cliAuth?.format).toBe("codex-cli");
    expect(cliAuth?.tokens?.accessToken).toBe("cli-access");
    expect(cliAuth?.tokens?.refreshToken).toBe("cli-refresh");
    expect(cliAuth?.tokens?.accountId).toBe("acct-cli");

    const apiKeyOnlyAuth = readCodexAuthFile(apiKeyOnlyPath);
    expect(apiKeyOnlyAuth?.format).toBe("api-key-only");
    expect(apiKeyOnlyAuth?.openAiApiKey).toBe("sk-test");
    expect(apiKeyOnlyAuth?.tokens).toBeNull();
  });
});
