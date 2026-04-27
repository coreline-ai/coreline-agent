import { describe, expect, test } from "bun:test";
import { createSseStream, encodeSseEvent } from "../src/proxy/sse.js";

describe("proxy SSE helpers", () => {
  test("encodeSseEvent formats event and data payloads", () => {
    expect(encodeSseEvent("message", { hello: "world" })).toBe(
      'event: message\ndata: {"hello":"world"}\n\n',
    );
    expect(encodeSseEvent(null, "[DONE]")).toBe("data: [DONE]\n\n");
  });

  test("createSseStream writes events and ignores writes after close", async () => {
    const { response, writer } = createSseStream();

    writer.writeEvent("ping", { count: 1 });
    writer.writeEvent(null, "[DONE]");
    writer.close();
    writer.writeEvent("late", { ignored: true });

    const text = await new Response(response).text();
    expect(text).toBe(
      'event: ping\ndata: {"count":1}\n\ndata: [DONE]\n\n',
    );
  });
});
