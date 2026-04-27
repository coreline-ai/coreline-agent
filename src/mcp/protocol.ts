/**
 * MCP JSON-RPC protocol helpers and stdio framing.
 */

import type { McpJsonRpcError } from "./types.js";

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: TResult;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: McpJsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

const HEADER_SEPARATOR = new TextEncoder().encode("\r\n\r\n");
const FALLBACK_SEPARATOR = new TextEncoder().encode("\n\n");
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export class McpProtocolError extends Error {
  constructor(message: string, public readonly data?: unknown) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export function encodeJsonRpcMessage(message: JsonRpcMessage): Uint8Array {
  const payload = JSON.stringify(message);
  const bytes = TEXT_ENCODER.encode(payload);
  const header = TEXT_ENCODER.encode(`Content-Length: ${bytes.byteLength}\r\n\r\n`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header, 0);
  framed.set(bytes, header.byteLength);
  return framed;
}

export class McpFrameParser {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0) as Uint8Array<ArrayBuffer>;

  push(chunk: Uint8Array | string): JsonRpcMessage[] {
    const bytes = typeof chunk === "string" ? TEXT_ENCODER.encode(chunk) : chunk;
    this.buffer = concatBytes(this.buffer, bytes);
    const messages: JsonRpcMessage[] = [];

    while (true) {
      const headerInfo = this.findHeader();
      if (!headerInfo) {
        break;
      }

      const { headerEnd, separatorLength } = headerInfo;
      const headerText = TEXT_DECODER.decode(this.buffer.slice(0, headerEnd));
      const contentLength = this.readContentLength(headerText);
      if (contentLength === null) {
        throw new McpProtocolError(`Missing Content-Length header in frame: ${headerText}`);
      }

      const bodyStart = headerEnd + separatorLength;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.byteLength < bodyEnd) {
        break;
      }

      const bodyBytes = this.buffer.slice(bodyStart, bodyEnd);
      const bodyText = TEXT_DECODER.decode(bodyBytes);
      try {
        messages.push(JSON.parse(bodyText) as JsonRpcMessage);
      } catch (error) {
        throw new McpProtocolError(`Failed to parse MCP JSON-RPC body: ${(error as Error).message}`, {
          bodyText,
        });
      }

      this.buffer = this.buffer.slice(bodyEnd);
    }

    return messages;
  }

  private findHeader(): { headerEnd: number; separatorLength: number } | null {
    const crlf = indexOfSequence(this.buffer, HEADER_SEPARATOR);
    if (crlf >= 0) {
      return { headerEnd: crlf, separatorLength: HEADER_SEPARATOR.byteLength };
    }

    const lf = indexOfSequence(this.buffer, FALLBACK_SEPARATOR);
    if (lf >= 0) {
      return { headerEnd: lf, separatorLength: FALLBACK_SEPARATOR.byteLength };
    }

    return null;
  }

  private readContentLength(headerText: string): number | null {
    for (const line of headerText.split(/\r?\n/)) {
      const [rawName, ...rest] = line.split(":");
      if (!rawName || rest.length === 0) {
        continue;
      }
      if (rawName.trim().toLowerCase() !== "content-length") {
        continue;
      }

      const parsed = Number.parseInt(rest.join(":").trim(), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
  }
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    typeof (message as { method?: unknown }).method === "string" &&
    "id" in message
  );
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcSuccess | JsonRpcFailure {
  return typeof message === "object" && message !== null && "id" in message && !("method" in message);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.byteLength === 0) return new Uint8Array(b) as Uint8Array<ArrayBuffer>;
  if (b.byteLength === 0) return new Uint8Array(a) as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(a.byteLength + b.byteLength) as Uint8Array<ArrayBuffer>;
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function indexOfSequence(buffer: Uint8Array, sequence: Uint8Array): number {
  if (sequence.byteLength === 0) return 0;
  if (buffer.byteLength < sequence.byteLength) return -1;

  outer: for (let i = 0; i <= buffer.byteLength - sequence.byteLength; i++) {
    for (let j = 0; j < sequence.byteLength; j++) {
      if (buffer[i + j] !== sequence[j]) {
        continue outer;
      }
    }
    return i;
  }

  return -1;
}
