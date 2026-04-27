export type WatchdogTimeoutHandler = (snapshot: WatchdogSnapshot) => void | Promise<void>;

export type WatchdogSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type WatchdogClearTimeout = (handle: unknown) => void;

export interface WatchdogSnapshot {
  active: boolean;
  stopped: boolean;
  timedOut: boolean;
  timeoutSeconds: number;
  startedAt: number | null;
  lastTouchAt: number | null;
  deadlineAt: number | null;
  remainingMs: number | null;
  elapsedMs: number | null;
  touchCount: number;
  lastLabel?: string;
}

export interface ProgressWatchdogOptions {
  timeoutSeconds?: number | null;
  onTimeout?: WatchdogTimeoutHandler;
  now?: () => number;
  setTimeoutImpl?: WatchdogSetTimeout;
  clearTimeoutImpl?: WatchdogClearTimeout;
}

const DEFAULT_NOW = () => Date.now();
const DEFAULT_SET_TIMEOUT: WatchdogSetTimeout = (callback, delayMs) => globalThis.setTimeout(callback, delayMs);
const DEFAULT_CLEAR_TIMEOUT: WatchdogClearTimeout = (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);

function normalizeTimeoutSeconds(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function parseWatchdogTimeoutSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return normalizeTimeoutSeconds(value);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export class ProgressWatchdog {
  private readonly timeoutSeconds: number;
  private readonly timeoutMs: number | null;
  private readonly onTimeout?: WatchdogTimeoutHandler;
  private readonly now: () => number;
  private readonly setTimeoutImpl: WatchdogSetTimeout;
  private readonly clearTimeoutImpl: WatchdogClearTimeout;

  private timerHandle: unknown | null = null;
  private startedAt: number | null = null;
  private lastTouchAt: number | null = null;
  private deadlineAt: number | null = null;
  private touchCount = 0;
  private lastLabel: string | undefined;
  private stopped = false;
  private timedOut = false;
  private active = false;

  constructor(options: ProgressWatchdogOptions = {}) {
    this.timeoutSeconds = normalizeTimeoutSeconds(options.timeoutSeconds) ?? 0;
    this.timeoutMs = this.timeoutSeconds > 0 ? this.timeoutSeconds * 1000 : null;
    this.onTimeout = options.onTimeout;
    this.now = options.now ?? DEFAULT_NOW;
    this.setTimeoutImpl = options.setTimeoutImpl ?? DEFAULT_SET_TIMEOUT;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? DEFAULT_CLEAR_TIMEOUT;
  }

  start(): WatchdogSnapshot {
    if (this.stopped || this.timedOut) {
      return this.getSnapshot();
    }

    if (this.startedAt != null) {
      return this.getSnapshot();
    }

    this.startedAt = this.now();
    this.lastTouchAt = this.startedAt;
    this.touchCount = 0;
    this.lastLabel = undefined;

    if (this.timeoutMs == null) {
      this.active = false;
      this.deadlineAt = null;
      this.clearTimer();
      return this.getSnapshot();
    }

    this.active = true;
    this.deadlineAt = this.startedAt + this.timeoutMs;
    this.scheduleTimer();
    return this.getSnapshot();
  }

  touch(label?: string): WatchdogSnapshot {
    if (this.stopped || this.timedOut) {
      return this.getSnapshot();
    }

    if (this.startedAt == null) {
      this.start();
    }

    if (this.timeoutMs == null) {
      this.lastTouchAt = this.now();
      this.lastLabel = label ?? this.lastLabel;
      return this.getSnapshot();
    }

    this.touchCount += 1;
    this.lastTouchAt = this.now();
    this.lastLabel = label ?? this.lastLabel;
    this.deadlineAt = this.lastTouchAt + this.timeoutMs;
    this.active = true;
    this.scheduleTimer();
    return this.getSnapshot();
  }

  stop(): WatchdogSnapshot {
    if (this.stopped) {
      return this.getSnapshot();
    }

    this.stopped = true;
    this.active = false;
    this.clearTimer();
    return this.getSnapshot();
  }

  getSnapshot(): WatchdogSnapshot {
    const now = this.now();
    const remainingMs = this.deadlineAt == null ? null : Math.max(0, this.deadlineAt - now);
    const elapsedMs = this.startedAt == null ? null : Math.max(0, now - this.startedAt);

    return {
      active: this.active && !this.stopped && !this.timedOut,
      stopped: this.stopped,
      timedOut: this.timedOut,
      timeoutSeconds: this.timeoutSeconds,
      startedAt: this.startedAt,
      lastTouchAt: this.lastTouchAt,
      deadlineAt: this.deadlineAt,
      remainingMs,
      elapsedMs,
      touchCount: this.touchCount,
      lastLabel: this.lastLabel,
    };
  }

  private clearTimer(): void {
    if (this.timerHandle != null) {
      this.clearTimeoutImpl(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private scheduleTimer(): void {
    if (this.timeoutMs == null || this.stopped || this.timedOut) {
      return;
    }

    this.clearTimer();
    this.timerHandle = this.setTimeoutImpl(() => {
      this.timerHandle = null;
      if (this.stopped || this.timedOut) {
        return;
      }
      this.timedOut = true;
      this.active = false;
      const snapshot = this.getSnapshot();
      void Promise.resolve(this.onTimeout?.(snapshot)).catch(() => {});
    }, this.timeoutMs);
  }
}
