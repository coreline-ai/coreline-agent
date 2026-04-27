/** Codex backend OAuth token and config file helpers. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry

export const DEFAULT_CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
export const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
export const FALLBACK_CODEX_PROXY_AUTH_PATH = join(
  homedir(),
  ".chatgpt-codex-proxy",
  "tokens.json",
);

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number; // ms epoch, 0 when unknown
  filePath: string;
}

export type CodexAuthFileFormat = "codex-cli" | "proxy" | "api-key-only";

export interface CodexAuthFile {
  filePath: string;
  format: CodexAuthFileFormat;
  tokens: CodexTokens | null;
  openAiApiKey?: string;
}

export interface CodexConfig {
  filePath: string;
  model?: string;
  modelReasoningEffort?: string;
  model_reasoning_effort?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

export function expandCodexPath(filePath: string): string {
  const expandedEnv = resolveEnvVars(filePath);
  if (expandedEnv === "~") return homedir();
  if (expandedEnv.startsWith("~/")) return join(homedir(), expandedEnv.slice(2));
  return expandedEnv;
}

function normalizeOptionalPath(filePath: string | undefined): string | undefined {
  if (!filePath || filePath.trim().length === 0) return undefined;
  return expandCodexPath(filePath.trim());
}

function uniqueDefined(paths: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function getCodexAuthSearchPaths(authFile?: string): string[] {
  return uniqueDefined([
    normalizeOptionalPath(authFile),
    normalizeOptionalPath(process.env.CODEX_AUTH_PATH),
    DEFAULT_CODEX_AUTH_PATH,
    FALLBACK_CODEX_PROXY_AUTH_PATH,
  ]);
}

export function resolveCodexConfigPath(configFile?: string): string {
  return (
    normalizeOptionalPath(configFile) ??
    normalizeOptionalPath(process.env.CODEX_CONFIG_PATH) ??
    DEFAULT_CODEX_CONFIG_PATH
  );
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
  return JSON.parse(payload);
}

function normalizeEpochMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const asDate = Date.parse(value);
    return Number.isFinite(asDate) ? asDate : 0;
  }
  return 0;
}

function inferTokenMetadata(
  accessToken: string,
  fallbackAccountId = "",
  fallbackExpiresAt = 0,
): { accountId: string; expiresAt: number } {
  let accountId = fallbackAccountId;
  let expiresAt = fallbackExpiresAt;

  try {
    const jwt = decodeJwt(accessToken);
    const auth = jwt["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: unknown }
      | undefined;
    const jwtAccountId = asString(auth?.chatgpt_account_id);
    if (jwtAccountId) accountId = jwtAccountId;
    if (typeof jwt.exp === "number") expiresAt = jwt.exp * 1000;
  } catch {
    // Codex auth files can contain opaque/non-JWT test tokens. Keep file metadata.
  }

  return { accountId, expiresAt };
}

function parseCodexCliTokens(
  data: Record<string, unknown>,
  filePath: string,
): CodexTokens | null {
  if (!isRecord(data.tokens)) return null;

  const accessToken = asString(data.tokens.access_token);
  const refreshToken = asString(data.tokens.refresh_token);
  if (!accessToken || !refreshToken) return null;

  const fallbackAccountId = asString(data.tokens.account_id) ?? "";
  const fallbackExpiresAt = normalizeEpochMillis(data.tokens.expires_at);
  const { accountId, expiresAt } = inferTokenMetadata(
    accessToken,
    fallbackAccountId,
    fallbackExpiresAt,
  );

  return { accessToken, refreshToken, accountId, expiresAt, filePath };
}

function parseProxyTokens(
  data: Record<string, unknown>,
  filePath: string,
): CodexTokens | null {
  const accessToken = asString(data.access_token);
  const refreshToken = asString(data.refresh_token);
  if (!accessToken || !refreshToken) return null;

  const fallbackAccountId =
    asString(data.chatgpt_account_id) ?? asString(data.account_id) ?? "";
  const fallbackExpiresAt = normalizeEpochMillis(data.expires_at);
  const { accountId, expiresAt } = inferTokenMetadata(
    accessToken,
    fallbackAccountId,
    fallbackExpiresAt,
  );

  return { accessToken, refreshToken, accountId, expiresAt, filePath };
}

export function readCodexAuthFile(filePath: string): CodexAuthFile | null {
  const expandedPath = expandCodexPath(filePath);
  if (!existsSync(expandedPath)) return null;

  try {
    const raw = readFileSync(expandedPath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!isRecord(data)) return null;

    const codexCliTokens = parseCodexCliTokens(data, expandedPath);
    if (codexCliTokens) {
      return {
        filePath: expandedPath,
        format: "codex-cli",
        tokens: codexCliTokens,
        openAiApiKey: asString(data.OPENAI_API_KEY),
      };
    }

    const proxyTokens = parseProxyTokens(data, expandedPath);
    if (proxyTokens) {
      return {
        filePath: expandedPath,
        format: "proxy",
        tokens: proxyTokens,
      };
    }

    const openAiApiKey = asString(data.OPENAI_API_KEY);
    if (openAiApiKey) {
      return {
        filePath: expandedPath,
        format: "api-key-only",
        tokens: null,
        openAiApiKey,
      };
    }
  } catch {
    // Keep auth discovery tolerant: malformed candidate files are skipped.
  }

  return null;
}

export function loadCodexTokensFromFile(filePath: string): CodexTokens | null {
  return readCodexAuthFile(filePath)?.tokens ?? null;
}

function saveTokens(tokens: CodexTokens): void {
  try {
    const raw = readFileSync(tokens.filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!isRecord(data)) return;

    if (isRecord(data.tokens)) {
      // Codex CLI format — preserve structure and update only token fields.
      data.tokens.access_token = tokens.accessToken;
      data.tokens.refresh_token = tokens.refreshToken;
      if (tokens.accountId) data.tokens.account_id = tokens.accountId;
      if (tokens.expiresAt > 0 && "expires_at" in data.tokens) {
        data.tokens.expires_at = tokens.expiresAt;
      }
      data.last_refresh = new Date().toISOString();
    } else {
      // Proxy format.
      data.access_token = tokens.accessToken;
      data.refresh_token = tokens.refreshToken;
      if (tokens.accountId) data.chatgpt_account_id = tokens.accountId;
      if (tokens.expiresAt > 0) data.expires_at = tokens.expiresAt;
    }

    writeFileSync(tokens.filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(
      `[codex-backend] Failed to persist refreshed tokens: ${(err as Error).message}`,
    );
  }
}

async function refreshTokens(tokens: CodexTokens): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(
      `[codex-backend] Token refresh failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const fallbackExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  const { accountId, expiresAt } = inferTokenMetadata(
    data.access_token,
    tokens.accountId,
    fallbackExpiresAt,
  );

  const refreshed: CodexTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    accountId,
    expiresAt,
    filePath: tokens.filePath,
  };

  saveTokens(refreshed);
  return refreshed;
}

export async function getValidCodexTokens(authFile?: string): Promise<CodexTokens> {
  const paths = getCodexAuthSearchPaths(authFile);
  const apiKeyOnlyPaths: string[] = [];

  let tokens: CodexTokens | null = null;
  for (const path of paths) {
    const auth = readCodexAuthFile(path);
    if (auth?.tokens) {
      tokens = auth.tokens;
      break;
    }
    if (auth?.openAiApiKey) {
      apiKeyOnlyPaths.push(auth.filePath);
    }
  }

  if (!tokens) {
    const apiKeyOnlyHint =
      apiKeyOnlyPaths.length > 0
        ? ` Found OPENAI_API_KEY-only auth file(s) without OAuth tokens: ${apiKeyOnlyPaths.join(", ")}.`
        : "";
    throw new Error(
      `[codex-backend] No Codex OAuth tokens found. Checked: ${paths.join(", ")}\n` +
        `Run 'codex auth login' or set oauthFile in providers.yml.` +
        apiKeyOnlyHint,
    );
  }

  if (tokens.expiresAt > 0 && Date.now() + REFRESH_BUFFER_MS >= tokens.expiresAt) {
    tokens = await refreshTokens(tokens);
  }

  return tokens;
}

function stripTomlComment(line: string): string {
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && char === "\\") {
      escaped = true;
      continue;
    }
    if (!quote && (char === "'" || char === "\"")) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && char === "#") {
      return line.slice(0, i);
    }
  }

  return line;
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  const singleQuoted = /^'([^']*)'/.exec(trimmed);
  if (singleQuoted) return singleQuoted[1];

  const doubleQuoted = /^"((?:\\.|[^"\\])*)"/.exec(trimmed);
  if (!doubleQuoted) return undefined;

  try {
    return JSON.parse(`"${doubleQuoted[1]}"`) as string;
  } catch {
    return doubleQuoted[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

export function parseCodexConfigToml(source: string, filePath = ""): CodexConfig {
  const config: CodexConfig = { filePath };
  let inTopLevel = true;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;

    const key = assignment[1];
    const value = parseTomlString(assignment[2]!);
    if (!value) continue;

    if (key === "model") {
      config.model = value;
    } else if (key === "model_reasoning_effort") {
      config.modelReasoningEffort = value;
      config.model_reasoning_effort = value;
    }
  }

  return config;
}

export function readCodexConfig(configFile?: string): CodexConfig {
  const filePath = resolveCodexConfigPath(configFile);
  if (!existsSync(filePath)) return { filePath };

  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseCodexConfigToml(raw, filePath);
  } catch {
    return { filePath };
  }
}
