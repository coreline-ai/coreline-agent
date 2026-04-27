/**
 * Google Gemini provider adapter.
 *
 * Uses @google/generative-ai SDK.
 * Converts Gemini's Part/FunctionCall format ↔ our ChatChunk stream.
 */

import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type Part,
  FunctionCallingMode,
  type GenerateContentStreamResult,
  SchemaType,
} from "@google/generative-ai";
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
// Message Conversion
// ---------------------------------------------------------------------------

function contentBlocksToParts(blocks: ContentBlock[]): Part[] {
  const parts: Part[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ text: block.text });
        break;
      case "tool_use":
        parts.push({
          functionCall: { name: block.name, args: block.input },
        });
        break;
      case "tool_result":
        parts.push({
          functionResponse: {
            name: block.toolUseId,
            response: { result: block.content },
          },
        });
        break;
    }
  }
  return parts;
}

function convertMessages(messages: ChatMessage[]): Content[] {
  const result: Content[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled via systemInstruction

    if (msg.role === "user") {
      const parts: Part[] =
        typeof msg.content === "string"
          ? [{ text: msg.content }]
          : contentBlocksToParts(msg.content);
      result.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      result.push({ role: "model", parts: contentBlocksToParts(msg.content) });
    }
  }

  return result;
}

function convertJsonSchemaType(type: string): SchemaType {
  switch (type) {
    case "string": return SchemaType.STRING;
    case "number": return SchemaType.NUMBER;
    case "integer": return SchemaType.INTEGER;
    case "boolean": return SchemaType.BOOLEAN;
    case "array": return SchemaType.ARRAY;
    case "object": return SchemaType.OBJECT;
    default: return SchemaType.STRING;
  }
}

export function convertTools(
  tools: ToolDefinition[],
  providerName = "gemini",
): FunctionDeclaration[] {
  return tools.map((t) => {
    if (isHostedToolDefinition(t)) {
      throw unsupportedHostedToolError(providerName, t);
    }

    const schema = t.inputSchema;
    const properties: Record<string, { type: SchemaType; description?: string }> = {};

    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, prop] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
        properties[key] = {
          type: convertJsonSchemaType((prop.type as string) ?? "string"),
          description: prop.description as string | undefined,
        };
      }
    }

    return {
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties,
        required: (schema.required as string[]) ?? [],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

export class GeminiProvider implements LLMProvider {
  readonly name: string;
  readonly type = "gemini" as const;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsToolCalling = true;
  readonly supportsPlanning = true;
  readonly supportsStreaming = true;

  private genAI: GoogleGenerativeAI;
  /** Maps synthetic tool call IDs → original Gemini function names for round-trip */
  private toolIdMap = new Map<string, string>();

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 1_000_000;

    const apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  /** Resolve tool result IDs: replace synthetic gemini_tc_N with original function name */
  private resolveToolResultNames(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg) => {
      if (msg.role !== "assistant" && msg.role !== "user") return msg;
      if (typeof msg.content === "string") return msg;
      const resolved = msg.content.map((block) => {
        if (block.type === "tool_result" && block.toolUseId.startsWith("gemini_tc_")) {
          const realName = this.toolIdMap.get(block.toolUseId);
          if (realName) {
            return { ...block, toolUseId: realName };
          }
        }
        return block;
      });
      return { ...msg, content: resolved } as ChatMessage;
    });
  }

  async *send(request: ChatRequest): AsyncIterable<ChatChunk> {
    const resolvedMessages = this.resolveToolResultNames(request.messages);
    const contents = convertMessages(resolvedMessages);

    const modelConfig: Record<string, unknown> = {};
    if (request.maxTokens) modelConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) modelConfig.temperature = request.temperature;

    const generativeModel = this.genAI.getGenerativeModel({
      model: this.model,
      generationConfig: modelConfig,
      ...(request.systemPrompt
        ? { systemInstruction: { role: "user", parts: [{ text: request.systemPrompt }] } }
        : {}),
        ...(request.tools && request.tools.length > 0
          ? {
            tools: [{ functionDeclarations: convertTools(request.tools, this.name) }],
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingMode.AUTO },
            },
          }
        : {}),
    });

    let streamResult: GenerateContentStreamResult;
    try {
      streamResult = await generativeModel.generateContentStream(
        { contents },
        { signal: request.signal ?? undefined },
      );
    } catch (err) {
      throw new Error(`[${this.name}] Gemini API error: ${(err as Error).message}`);
    }

    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let hasToolCalls = false;
    let toolCallCounter = 0;
    this.toolIdMap.clear(); // Fresh map per request

    for await (const chunk of streamResult.stream) {
      // Usage metadata
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
        };
      }

      for (const candidate of chunk.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if ("text" in part && part.text) {
            yield { type: "text_delta", text: part.text };
          }

          if ("functionCall" in part && part.functionCall) {
            hasToolCalls = true;
            const id = `gemini_tc_${toolCallCounter++}`;
            this.toolIdMap.set(id, part.functionCall.name);
            yield {
              type: "tool_call_start",
              toolCall: { id, name: part.functionCall.name },
            };
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

    yield {
      type: "done",
      usage,
      stopReason: hasToolCalls ? "tool_use" : "end_turn",
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
}
