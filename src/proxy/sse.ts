/**
 * Small SSE helpers for the proxy response path.
 */

export function encodeSseEvent(event: string | null, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const prefix = event ? `event: ${event}\n` : "";
  return `${prefix}data: ${payload}\n\n`;
}

export interface SseWriter {
  writeEvent(event: string | null, data: unknown): void;
  close(): void;
}

export function createSseStream(): {
  response: ReadableStream<Uint8Array>;
  writer: SseWriter;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const response = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  const writer: SseWriter = {
    writeEvent(event, data) {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* ignore */
      }
    },
  };

  return { response, writer };
}
