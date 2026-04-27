/**
 * MCP framing and protocol helper tests.
 */

import { describe, expect, test } from "bun:test";
import {
  encodeJsonRpcMessage,
  McpFrameParser,
  type JsonRpcMessage,
} from "../src/mcp/protocol.js";

describe("MCP protocol framing", () => {
  test("parses fragmented framed messages", () => {
    const parser = new McpFrameParser();
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    };
    const framed = encodeJsonRpcMessage(message);
    const split = Math.max(1, Math.floor(framed.byteLength / 2));

    const first = parser.push(framed.slice(0, split));
    expect(first).toHaveLength(0);

    const second = parser.push(framed.slice(split));
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(message);
  });

  test("parses multiple messages from a single chunk", () => {
    const parser = new McpFrameParser();
    const messageA: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { hello: "world" },
    };
    const messageB: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    const framed = new Uint8Array(
      encodeJsonRpcMessage(messageA).byteLength + encodeJsonRpcMessage(messageB).byteLength,
    );
    framed.set(encodeJsonRpcMessage(messageA), 0);
    framed.set(encodeJsonRpcMessage(messageB), encodeJsonRpcMessage(messageA).byteLength);

    const parsed = parser.push(framed);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(messageA);
    expect(parsed[1]).toEqual(messageB);
  });
});
