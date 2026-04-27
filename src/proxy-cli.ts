#!/usr/bin/env bun
/**
 * coreline-agent-proxy — standalone proxy server entrypoint.
 *
 * Loads provider config the same way the main agent does (providers.yml +
 * env var fallback), optionally auto-registers CLI fallback providers
 * when the corresponding binaries are on PATH, then starts the HTTP proxy.
 *
 * Usage:
 *   coreline-agent-proxy [--port 4317] [--host 127.0.0.1] [--auth-token T]
 *                        [--with-cli-fallback]
 */

import { Command } from "commander";
import { ProviderRegistryImpl } from "./providers/registry.js";
import {
  loadProviders,
  loadSettings,
  resolveDefaultProviderName,
} from "./config/loader.js";
import { ensureConfigDirs } from "./config/paths.js";
import type { ProviderConfig } from "./providers/types.js";
import { startProxyServer } from "./proxy/server.js";
import { StatusTracker } from "./agent/status.js";
import { createLifecycle, type LifecycleController } from "./agent/lifecycle.js";
import { runCli } from "./providers/cli-shared.js";

const VERSION = "0.1.0";

let runtimeLifecycle: LifecycleController | null = null;

const program = new Command()
  .name("coreline-agent-proxy")
  .description(
    "Local LLM proxy exposing Anthropic / OpenAI / Responses APIs over a registered provider set",
  )
  .version(VERSION, "-v, --version")
  .option("--port <n>", "listen port (default: $PROXY_PORT or 4317)")
  .option("--host <addr>", "listen host (default: $PROXY_HOST or 127.0.0.1)")
  .option("--auth-token <token>", "require this bearer token on every request")
  .option("--max-batch-items <n>", "maximum batch items per request (default: 8)")
  .option("--max-batch-concurrency <n>", "maximum concurrent batch items (default: 4)")
  .option("--batch-timeout-ms <n>", "per-item batch timeout in milliseconds (default: 30000)")
  .option(
    "--with-cli-fallback",
    "auto-register `claude`/`gemini`/`codex` CLI providers if the binaries are on PATH",
  )
  .option("--default <name>", "override default provider name")
  .option("--verbose", "verbose logging");

program.parse(process.argv);

const opts = program.opts<{
  port?: string;
  host?: string;
  authToken?: string;
  maxBatchItems?: string;
  maxBatchConcurrency?: string;
  batchTimeoutMs?: string;
  withCliFallback?: boolean;
  default?: string;
  verbose?: boolean;
}>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFallbackProvider(): ProviderConfig | null {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      name: "claude",
      type: "anthropic",
      model: "claude-sonnet-4-5-20241022",
      apiKey: process.env.ANTHROPIC_API_KEY,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      type: "openai",
      model: "gpt-4o",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  if (process.env.GOOGLE_API_KEY) {
    return {
      name: "gemini",
      type: "gemini",
      model: "gemini-2.5-pro",
      apiKey: process.env.GOOGLE_API_KEY,
    };
  }
  return null;
}

async function binaryExists(bin: string): Promise<boolean> {
  try {
    const r = await runCli({ cmd: ["which", bin], timeoutMs: 2000 });
    return r.exitCode === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function buildCliFallbackProviders(existing: ProviderConfig[]): Promise<ProviderConfig[]> {
  const known = new Set(existing.map((c) => c.name));
  const extras: ProviderConfig[] = [];

  if (!known.has("claude-cli") && (await binaryExists("claude"))) {
    extras.push({
      name: "claude-cli",
      type: "claude-cli",
      model: "claude-sonnet-4-5",
    });
  }
  if (!known.has("gemini-cli") && (await binaryExists("gemini"))) {
    extras.push({
      name: "gemini-cli",
      type: "gemini-cli",
      model: "gemini-2.5-pro",
    });
  }
  if (!known.has("codex-cli") && (await binaryExists("codex"))) {
    extras.push({
      name: "codex-cli",
      type: "codex-cli",
      model: "gpt-5",
    });
  }
  return extras;
}


function safeDefaultName(registry: ProviderRegistryImpl): string | undefined {
  try {
    return registry.getDefault().name;
  } catch {
    return undefined;
  }
}

function safeDefaultModel(registry: ProviderRegistryImpl): string | undefined {
  try {
    return registry.getDefault().model;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureConfigDirs();

  const settings = loadSettings();
  let { configs, defaultName } = loadProviders();

  if (configs.length === 0) {
    const fallback = resolveFallbackProvider();
    if (fallback) {
      configs = [fallback];
      defaultName = fallback.name;
    }
  }

  if (opts.withCliFallback) {
    const extras = await buildCliFallbackProviders(configs);
    if (extras.length > 0) {
      configs = [...configs, ...extras];
      if (opts.verbose) {
        console.error(
          `[proxy] auto-registered CLI fallback providers: ${extras.map((e) => e.name).join(", ")}`,
        );
      }
    }
  }

  defaultName = resolveDefaultProviderName({
    cliProvider: opts.default,
    settingsDefaultProvider: settings.defaultProvider,
    providersDefaultName: defaultName,
  });

  if (configs.length === 0) {
    console.error("coreline-agent-proxy v" + VERSION);
    console.error("\nNo providers configured. Options:");
    console.error("  • Create ~/.coreline-agent/providers.yml");
    console.error("  • Export ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY");
    console.error("  • Pass --with-cli-fallback to auto-register claude/gemini/codex CLIs on PATH");
    process.exit(1);
  }

  const registry = new ProviderRegistryImpl(configs, defaultName);

  const statusTracker = new StatusTracker({
    initial: {
      status: "running",
      mode: "proxy",
      provider: safeDefaultName(registry),
      model: safeDefaultModel(registry),
      message: "proxy listening",
      cwd: process.cwd(),
    },
  });
  statusTracker.write();

  runtimeLifecycle = createLifecycle({
    onSessionEnd: ({ reason }) => {
      statusTracker.close("exited", reason);
    },
  });

  const handle = startProxyServer({
    registry,
    statusTracker,
    port: opts.port ? Number(opts.port) : undefined,
    host: opts.host,
    authToken: opts.authToken,
    maxBatchItems: opts.maxBatchItems ? Number(opts.maxBatchItems) : undefined,
    maxBatchConcurrency: opts.maxBatchConcurrency ? Number(opts.maxBatchConcurrency) : undefined,
    batchTimeoutMs: opts.batchTimeoutMs ? Number(opts.batchTimeoutMs) : undefined,
  });

  runtimeLifecycle.addCleanup(() => {
    console.error("\n[proxy] shutting down...");
    handle.stop();
  }, "proxy.stop");

  process.on("SIGINT", () => {
    void runtimeLifecycle?.destroy("SIGINT");
  });
  process.on("SIGTERM", () => {
    void runtimeLifecycle?.destroy("SIGTERM");
  });
  process.on("beforeExit", () => {
    void runtimeLifecycle?.destroy("beforeExit");
  });
  process.on("uncaughtException", (error) => {
    console.error("[coreline-agent-proxy] uncaught exception:", error);
    process.exitCode = 1;
    void runtimeLifecycle?.destroy("uncaughtException", error);
  });
}

main().catch(async (err) => {
  console.error("[coreline-agent-proxy] fatal:", err);
  await runtimeLifecycle?.destroy("uncaughtException", err);
  process.exit(1);
});
