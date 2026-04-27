import { describe, expect, test } from "bun:test";
import { parseWatchdogTimeoutSeconds, ProgressWatchdog, type WatchdogSnapshot } from "../src/agent/watchdog.js";

function createManualClock(startAt = 0) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();

  return {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { due: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(Number(handle));
    },
    advance: (deltaMs: number) => {
      now += deltaMs;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const dueTimers = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort((a, b) => a[1].due - b[1].due);

        for (const [id, timer] of dueTimers) {
          if (!timers.has(id)) {
            continue;
          }
          timers.delete(id);
          timer.callback();
          progressed = true;
        }
      }
    },
    pendingCount: () => timers.size,
  };
}

describe("watchdog core", () => {
  test("timeout fires when progress stalls", async () => {
    const clock = createManualClock();
    let observed: WatchdogSnapshot | null = null;

    const watchdog = new ProgressWatchdog({
      timeoutSeconds: 2,
      now: clock.now,
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
      onTimeout: (snapshot) => {
        observed = snapshot;
      },
    });

    watchdog.start();
    expect(watchdog.getSnapshot().active).toBe(true);

    clock.advance(1999);
    expect(observed).toBeNull();
    expect(watchdog.getSnapshot().timedOut).toBe(false);

    clock.advance(1);
    await Promise.resolve();
    expect(observed).not.toBeNull();
    expect(observed?.timedOut).toBe(true);
    expect(observed?.active).toBe(false);
    expect(watchdog.getSnapshot().timedOut).toBe(true);
  });

  test("touch resets the deadline", async () => {
    const clock = createManualClock();
    let timeoutCount = 0;

    const watchdog = new ProgressWatchdog({
      timeoutSeconds: 2,
      now: clock.now,
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
      onTimeout: () => {
        timeoutCount += 1;
      },
    });

    watchdog.start();
    clock.advance(1500);
    watchdog.touch("progress");

    clock.advance(1400);
    await Promise.resolve();
    expect(timeoutCount).toBe(0);
    expect(watchdog.getSnapshot().timedOut).toBe(false);

    clock.advance(600);
    await Promise.resolve();
    expect(timeoutCount).toBe(1);
    expect(watchdog.getSnapshot().timedOut).toBe(true);
    expect(watchdog.getSnapshot().lastLabel).toBe("progress");
  });

  test("stop prevents timeout callbacks", () => {
    const clock = createManualClock();
    let timeoutCount = 0;

    const watchdog = new ProgressWatchdog({
      timeoutSeconds: 1,
      now: clock.now,
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
      onTimeout: () => {
        timeoutCount += 1;
      },
    });

    watchdog.start();
    watchdog.stop();
    clock.advance(2000);

    expect(timeoutCount).toBe(0);
    expect(watchdog.getSnapshot().stopped).toBe(true);
    expect(watchdog.getSnapshot().active).toBe(false);
  });

  test("invalid timeout parsing returns undefined", () => {
    expect(parseWatchdogTimeoutSeconds(undefined)).toBeUndefined();
    expect(parseWatchdogTimeoutSeconds(null)).toBeUndefined();
    expect(parseWatchdogTimeoutSeconds("")).toBeUndefined();
    expect(parseWatchdogTimeoutSeconds("abc")).toBeUndefined();
    expect(parseWatchdogTimeoutSeconds("-1")).toBeUndefined();
    expect(parseWatchdogTimeoutSeconds(0)).toBeUndefined();
    expect(parseWatchdogTimeoutSeconds("2.5")).toBe(2.5);
    expect(parseWatchdogTimeoutSeconds(3)).toBe(3);
  });
});
