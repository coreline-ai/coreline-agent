import type { AgentStatusSnapshot, StatusTracker } from "../agent/status.js";
import { createSseStream, type SseWriter } from "./sse.js";
import type { StatusStreamEvent, StatusStreamEventName } from "./platform-types.js";

export interface StatusStreamOptions {
  keepaliveMs?: number;
  includeInitialSnapshot?: boolean;
  now?: () => Date;
}

export interface StatusStreamHandle {
  response: Response;
  writer: SseWriter;
  close(): void;
}

export function createStatusStream(
  tracker: StatusTracker,
  options: StatusStreamOptions = {},
): StatusStreamHandle {
  const { response: stream, writer } = createSseStream();
  const now = options.now ?? (() => new Date());
  let closed = false;

  const write = (event: StatusStreamEventName, status?: AgentStatusSnapshot, message?: string) => {
    if (closed) return;
    writer.writeEvent(event, createStatusStreamEvent(event, { status, message, now }));
  };

  if (options.includeInitialSnapshot !== false) {
    write("snapshot", tracker.get());
  }

  const unsubscribe = tracker.onStatusChange((snapshot) => write("status", snapshot));
  const keepaliveMs = options.keepaliveMs ?? 15000;
  const keepalive = keepaliveMs > 0
    ? setInterval(() => write("keepalive", undefined, "ok"), keepaliveMs)
    : null;

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (keepalive) clearInterval(keepalive);
    writer.close();
  };

  return {
    response: new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    }),
    writer,
    close,
  };
}

export function createStatusStreamEvent(
  event: StatusStreamEventName,
  input: { status?: AgentStatusSnapshot; message?: string; now?: () => Date } = {},
): StatusStreamEvent {
  const streamEvent: StatusStreamEvent = {
    type: "status_stream_event",
    event,
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
    status: input.status,
    message: input.message,
  };
  return compact(streamEvent);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
