/**
 * Gemini Code Assist Provider — uses Google OAuth tokens (no API key).
 *
 * Reads credentials from ~/.gemini/oauth_creds.json (from `gemini` CLI)
 * and calls https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent.
 *
 * Auto-refreshes OAuth tokens when near expiry.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ContentBlock, Usage } from "../agent/types.js";
import type {
  ChatChunk,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  ToolDefinition,
} from "./types.js";
import {
  isHostedToolDefinition,
  unsupportedHostedToolError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_PATH = join(homedir(), ".gemini", "oauth_creds.json");
const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_VERSION = "v1internal";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Default Google client credentials used by Gemini CLI (public, not secret)
const DEFAULT_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID ??
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET ??
  "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";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface GeminiCreds {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  filePath: string;
}

function loadCreds(filePath: string): GeminiCreds | null {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (data.access_token && data.refresh_token) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expiry_date: data.expiry_date ?? 0,
        token_type: data.token_type,
        scope: data.scope,
        id_token: data.id_token,
        filePath,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function saveCreds(creds: GeminiCreds): void {
  try {
    const data = {
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
      token_type: creds.token_type,
      scope: creds.scope,
      id_token: creds.id_token,
    };
    writeFileSync(creds.filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`[gemini-code-assist] Failed to save refreshed tokens: ${(err as Error).message}`);
  }
}

async function refreshCreds(creds: GeminiCreds): Promise<GeminiCreds> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    client_id: DEFAULT_CLIENT_ID,
    client_secret: DEFAULT_CLIENT_SECRET,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(
      `[gemini-code-assist] Token refresh failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    id_token?: string;
  };

  const refreshed: GeminiCreds = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? creds.refresh_token,
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type ?? creds.token_type,
    scope: data.scope ?? creds.scope,
    id_token: data.id_token ?? creds.id_token,
    filePath: creds.filePath,
  };

  saveCreds(refreshed);
  return refreshed;
}

async function getValidCreds(authFile?: string): Promise<GeminiCreds> {
  const path = authFile ?? DEFAULT_AUTH_PATH;
  let creds = loadCreds(path);
  if (!creds) {
    throw new Error(
      `[gemini-code-assist] No Gemini OAuth credentials at ${path}.\n` +
      `Run 'gemini auth login' or set oauthFile in providers.yml.`,
    );
  }

  if (creds.expiry_date > 0 && Date.now() + REFRESH_BUFFER_MS >= creds.expiry_date) {
    creds = await refreshCreds(creds);
  }

  return creds;
}

// ---------------------------------------------------------------------------
// Project Discovery
// ---------------------------------------------------------------------------

async function discoverProject(accessToken: string, configProject?: string): Promise<string> {
  if (configProject) return configProject;

  // Call loadCodeAssist to get the default project
  try {
    const resp = await fetch(`${CODE_ASSIST_BASE}/${CODE_ASSIST_VERSION}:loadCodeAssist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    if (resp.ok) {
      const data = await resp.json() as { cloudaicompanionProject?: string };
      if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
    }
  } catch {
    // ignore
  }

  // Fallback: list projects via resource manager
  try {
    const resp = await fetch(
      "https://cloudresourcemanager.googleapis.com/v1/projects",
      { headers: { "Authorization": `Bearer ${accessToken}` } },
    );
    if (resp.ok) {
      const data = await resp.json() as { projects?: Array<{ projectId: string }> };
      if (data.projects && data.projects.length > 0) {
        return data.projects[0]!.projectId;
      }
    }
  } catch {
    // ignore
  }

  throw new Error(
    "[gemini-code-assist] Could not discover GCP project. " +
    "Set geminiProject in providers.yml or run 'gcloud config set project PROJECT_ID'.",
  );
}

// ---------------------------------------------------------------------------
// Message / Tool Conversion
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function convertMessages(messages: ChatMessage[], toolIdMap: Map<string, string>): {
  contents: GeminiContent[];
  systemInstruction?: string;
} {
  const contents: GeminiContent[] = [];
  let systemInstruction: string | undefined;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content;
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      } else {
        const parts: GeminiPart[] = [];
        for (const block of msg.content) {
          if (block.type === "text") parts.push({ text: block.text });
          else if (block.type === "tool_result") {
            const functionName = toolIdMap.get(block.toolUseId) ?? block.toolUseId;
            parts.push({
              functionResponse: {
                name: functionName,
                response: { result: block.content },
              },
            });
          }
        }
        if (parts.length > 0) contents.push({ role: "user", parts });
      }
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text") parts.push({ text: block.text });
        else if (block.type === "tool_use") {
          parts.push({
            functionCall: { name: block.name, args: block.input },
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    }
  }

  return { contents, systemInstruction };
}

export function convertTools(
  tools: ToolDefinition[],
  providerName = "gemini-code-assist",
): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((t) => {
      if (isHostedToolDefinition(t)) {
        throw unsupportedHostedToolError(providerName, t);
      }

      return {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      };
    }),
  }];
}

// ---------------------------------------------------------------------------
// SSE Parser
// ---------------------------------------------------------------------------

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("data: ")) {
          const data = t.slice(6);
          if (data === "[DONE]") return;
          try { yield JSON.parse(data); } catch { /* skip */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

export class GeminiCodeAssistProvider implements LLMProvider {
  readonly name: string;
  readonly type = "gemini-code-assist" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = true;
  readonly supportsPlanning = true;
  readonly supportsStreaming = true;

  private authFile?: string;
  private project?: string;
  private toolIdMap = new Map<string, string>();

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model; // e.g. "gemini-2.5-pro", "gemini-2.0-flash-exp"
    this.authFile = config.oauthFile;
    this.maxContextTokens = config.maxContextTokens ?? 1_000_000;

    // Allow explicit project override via provider config
    const extended = config as ProviderConfig & { geminiProject?: string };
    this.project = extended.geminiProject;
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const creds = await getValidCreds(this.authFile);
    const project = await discoverProject(creds.access_token, this.project);
    if (!this.project) this.project = project; // cache

    this.toolIdMap.clear();
    const { contents, systemInstruction } = convertMessages(request.messages, this.toolIdMap);

    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;

    const body: Record<string, unknown> = {
      model: this.model,
      project,
      request: {
        contents,
        ...(systemInstruction || request.systemPrompt
          ? { systemInstruction: { parts: [{ text: systemInstruction ?? request.systemPrompt }] } }
          : {}),
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        ...(request.tools && request.tools.length > 0
          ? { tools: convertTools(request.tools, this.name) }
          : {}),
      },
    };

    const url = `${CODE_ASSIST_BASE}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${creds.access_token}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      throw new Error(`[${this.name}] Gemini Code Assist ${response.status}: ${errText}`);
    }
    if (!response.body) {
      throw new Error(`[${this.name}] No response body`);
    }

    const reader = response.body.getReader();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let hasToolCalls = false;
    let toolCounter = 0;

    for await (const chunk of parseSSE(reader)) {
      const c = chunk as { response?: { candidates?: Array<Record<string, unknown>>; usageMetadata?: Record<string, number> } };
      const resp = c.response;
      if (!resp) continue;

      if (resp.usageMetadata) {
        usage = {
          inputTokens: resp.usageMetadata.promptTokenCount ?? 0,
          outputTokens: resp.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: resp.usageMetadata.totalTokenCount ?? 0,
        };
      }

      for (const candidate of resp.candidates ?? []) {
        const content = candidate.content as { parts?: GeminiPart[] } | undefined;
        for (const part of content?.parts ?? []) {
          // Reasoning (thought)
          if ((part as { thought?: boolean }).thought && part.text) {
            yield { type: "reasoning_delta", text: part.text };
            continue;
          }

          // Text
          if (part.text) {
            yield { type: "text_delta", text: part.text };
            continue;
          }

          // Function call
          if (part.functionCall) {
            hasToolCalls = true;
            const id = `gemini_tc_${toolCounter++}`;
            this.toolIdMap.set(id, part.functionCall.name);
            yield { type: "tool_call_start", toolCall: { id, name: part.functionCall.name } };
            yield {
              type: "tool_call_delta",
              toolCallId: id,
              inputDelta: JSON.stringify(part.functionCall.args ?? {}),
            };
            yield { type: "tool_call_end", toolCallId: id };
          }
        }
      }
    }

    yield { type: "done", usage, stopReason: hasToolCalls ? "tool_use" : "end_turn" };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
}
