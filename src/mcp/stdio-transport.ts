/**
 * Stdio-based MCP transport.
 */

import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcResponse,
  McpFrameParser,
  McpProtocolError,
  type JsonRpcFailure,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "./protocol.js";
import {
  type McpJsonRpcError,
  type McpTransportDiagnostics,
  type McpTransport,
  type McpTransportRequestOptions,
} from "./types.js";

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface McpStdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
    title?: string;
    description?: string;
  };
}

export class StdioMcpTransport implements McpTransport {
  private readonly options: Required<Pick<McpStdioTransportOptions, "timeoutMs" | "shutdownTimeoutMs">> &
    McpStdioTransportOptions;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly parser = new McpFrameParser();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly textDecoder = new TextDecoder();
  private requestId = 0;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private stderrBuffer = "";

  constructor(options: McpStdioTransportOptions) {
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
    };
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: McpTransportRequestOptions,
  ): Promise<TResult> {
    await this.ensureStarted();
    if (this.closed) {
      throw new Error(`MCP transport is closed for ${this.options.command}`);
    }

    const id = String(++this.requestId);
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    const timeoutMs = options?.timeoutMs ?? this.options.timeoutMs;

    return await new Promise<TResult>(async (resolve, reject) => {
      const pending: PendingRequest<TResult> = {
        resolve,
        reject: (error) => reject(error),
      };
      this.pending.set(id, pending as PendingRequest);

      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          const error = new Error(`MCP request timed out after ${timeoutMs}ms (${method})`);
          reject(error);
          options?.signal?.removeEventListener("abort", pending.onAbort ?? noop);
        }, timeoutMs);
      }

      if (options?.signal) {
        pending.signal = options.signal;
        pending.onAbort = () => {
          this.pending.delete(id);
          clearTimeout(pending.timeout);
          reject(new Error(`MCP request aborted (${method})`));
        };
        if (options.signal.aborted) {
          pending.onAbort();
          return;
        }
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }

      try {
        await this.sendMessage(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        if (pending.signal && pending.onAbort) {
          pending.signal.removeEventListener("abort", pending.onAbort);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    if (this.closed) {
      throw new Error(`MCP transport is closed for ${this.options.command}`);
    }

    const payload = {
      jsonrpc: "2.0" as const,
      method,
      ...(params === undefined ? {} : { params }),
    };
    await this.sendMessage(payload);
  }

  async close(): Promise<void> {
    this.closed = true;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(new Error(`MCP transport closed before response (${id})`));
    }
    this.pending.clear();

    if (!this.proc) {
      return;
    }

    try {
      if (this.proc.stdin) {
        await (this.proc.stdin as any).end();
      }
    } catch {
      /* ignore */
    }

    const exitCode = await Promise.race([
      this.proc.exited,
      delay(this.options.shutdownTimeoutMs),
    ]);

    if (exitCode === undefined) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  async ping(timeoutMs?: number): Promise<void> {
    await this.request("ping", undefined, { timeoutMs });
  }

  get stderr(): string {
    return this.stderrBuffer.trim();
  }

  getDiagnostics(): McpTransportDiagnostics {
    return {
      kind: "stdio",
      command: this.options.command,
      args: [...(this.options.args ?? [])],
      stderrTail: this.stderr ? this.stderr.slice(-2_000) : undefined,
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.proc) {
      return;
    }

    const cmd = [this.options.command, ...(this.options.args ?? [])];
    const env = {
      ...(process.env as Record<string, string>),
      ...(this.options.env ?? {}),
    };

    try {
      this.proc = Bun.spawn({
        cmd,
        cwd: this.options.cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      this.startPromise = null;
      throw new Error(`Failed to start MCP server ${cmd.join(" ")}: ${(error as Error).message}`);
    }

    this.stdoutReader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    this.stderrReader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();

    void this.readStdoutLoop();
    void this.readStderrLoop();
    void this.watchProcessExit();
  }

  private async watchProcessExit(): Promise<void> {
    if (!this.proc) {
      return;
    }

    const exitCode = await this.proc.exited.catch(() => undefined);
    if (exitCode !== undefined) {
      this.rejectAllPending(new Error(`MCP server exited with code ${exitCode}`));
    }
  }

  private async readStdoutLoop(): Promise<void> {
    if (!this.stdoutReader) {
      return;
    }

    try {
      while (true) {
        const { value, done } = await this.stdoutReader.read();
        if (done) {
          break;
        }
        const messages = this.parser.push(value);
        for (const message of messages) {
          void this.handleInboundMessage(message);
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async readStderrLoop(): Promise<void> {
    if (!this.stderrReader) {
      return;
    }

    try {
      while (true) {
        const { value, done } = await this.stderrReader.read();
        if (done) {
          break;
        }
        this.stderrBuffer += this.textDecoder.decode(value, { stream: true });
        if (this.stderrBuffer.length > 8_000) {
          this.stderrBuffer = this.stderrBuffer.slice(-4_000);
        }
      }
    } catch {
      /* ignore stderr errors */
    }
  }

  private async handleInboundMessage(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isJsonRpcRequest(message)) {
      await this.handleServerRequest(message);
    }
  }

  private handleResponse(message: JsonRpcSuccess | JsonRpcFailure): void {
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }

    if ("error" in message) {
      pending.reject(this.toError(message.error));
      return;
    }

    pending.resolve(message.result as never);
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    if (message.method === "ping") {
      await this.sendMessage({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    await this.sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported MCP client request: ${message.method}`,
      },
    });
  }

  private async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (!this.proc?.stdin) {
      throw new Error("MCP transport is not started");
    }

    await (this.proc.stdin as any).write(encodeJsonRpcMessage(message));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private toError(error: McpJsonRpcError): Error {
    const message = error.data === undefined ? error.message : `${error.message}: ${safeJson(error.data)}`;
    const err = new Error(message);
    (err as Error & { code?: number; data?: unknown }).code = error.code;
    (err as Error & { code?: number; data?: unknown }).data = error.data;
    return err;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve(undefined);
      return;
    }
    setTimeout(() => resolve(undefined), ms);
  });
}

function noop(): void {
  /* noop */
}
