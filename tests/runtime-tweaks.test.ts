import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUNTIME_TWEAKS,
  RuntimeTweakError,
  RuntimeTweaks,
  parseRuntimeTweakKey,
  parseRuntimeTweakValue,
} from "../src/config/runtime-tweaks.js";

describe("runtime-tweaks parsing", () => {
  test("parses number and boolean values strictly", () => {
    expect(parseRuntimeTweakKey("maxTurns")).toBe("maxTurns");
    expect(parseRuntimeTweakValue("maxTurns", "12")).toBe(12);
    expect(parseRuntimeTweakValue("temperature", "0.25")).toBe(0.25);
    expect(parseRuntimeTweakValue("budget", 2.5)).toBe(2.5);
    expect(parseRuntimeTweakValue("autoSummary", "true")).toBe(true);
    expect(parseRuntimeTweakValue("showReasoning", false)).toBe(false);
    expect(parseRuntimeTweakValue("maxResultChars", "12000")).toBe(12_000);
  });

  test("rejects out-of-bounds numeric values", () => {
    expect(() => parseRuntimeTweakValue("maxTurns", "0")).toThrow(RuntimeTweakError);
    expect(() => parseRuntimeTweakValue("maxTurns", "201")).toThrow(RuntimeTweakError);
    expect(() => parseRuntimeTweakValue("temperature", "-0.1")).toThrow(RuntimeTweakError);
    expect(() => parseRuntimeTweakValue("temperature", "2.1")).toThrow(RuntimeTweakError);
    expect(() => parseRuntimeTweakValue("budget", "-1")).toThrow(RuntimeTweakError);
    expect(() => parseRuntimeTweakValue("maxResultChars", "999")).toThrow(RuntimeTweakError);
  });

  test("rejects unknown keys", () => {
    expect(() => parseRuntimeTweakKey("unknown")).toThrow("Unknown runtime tweak key");

    const tweaks = new RuntimeTweaks();
    expect(() => tweaks.set("unknown", "1")).toThrow("Unknown runtime tweak key");
  });
});

describe("RuntimeTweaks", () => {
  test("set, reset, history, getAll and snapshot work together", () => {
    const timestamps = [
      new Date("2026-04-20T10:00:00.000Z"),
      new Date("2026-04-20T10:00:01.000Z"),
      new Date("2026-04-20T10:00:02.000Z"),
    ];
    const seen: string[] = [];
    const tweaks = new RuntimeTweaks({
      now: () => timestamps[Math.min(seen.length, timestamps.length - 1)],
      onChange: (record, snapshot) => {
        seen.push(`${record.key}:${record.changed}`);
        expect(snapshot.values.maxTurns).toBe(record.nextValue);
      },
    });

    expect(tweaks.getAll()).toEqual(DEFAULT_RUNTIME_TWEAKS);
    expect(tweaks.formatStatus()).toBe("runtime tweaks: default");

    const setRecord = tweaks.set("maxTurns", "12");
    expect(setRecord).toMatchObject({
      id: 1,
      key: "maxTurns",
      source: "set",
      previousValue: 50,
      nextValue: 12,
      changed: true,
    });

    expect(tweaks.get("maxTurns")).toBe(12);
    expect(tweaks.formatStatus()).toContain("maxTurns=12");

    const resetRecord = tweaks.reset("maxTurns");
    expect(resetRecord).toMatchObject({
      id: 2,
      key: "maxTurns",
      source: "reset",
      previousValue: 12,
      nextValue: 50,
      changed: true,
    });

    expect(tweaks.get("maxTurns")).toBe(50);
    expect(tweaks.getAll()).toEqual(DEFAULT_RUNTIME_TWEAKS);

    const snapshot = tweaks.snapshot();
    expect(snapshot.values).toEqual(DEFAULT_RUNTIME_TWEAKS);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history[0]).toMatchObject({
      id: 1,
      key: "maxTurns",
      source: "set",
      previousValue: 50,
      nextValue: 12,
      changed: true,
      createdAt: "2026-04-20T10:00:00.000Z",
    });
    expect(snapshot.history[1]).toMatchObject({
      id: 2,
      key: "maxTurns",
      source: "reset",
      previousValue: 12,
      nextValue: 50,
      changed: true,
      createdAt: "2026-04-20T10:00:01.000Z",
    });

    snapshot.values.maxTurns = 999;
    snapshot.history[0].nextValue = 999;
    expect(tweaks.get("maxTurns")).toBe(50);
    expect(tweaks.snapshot().values.maxTurns).toBe(50);

    expect(seen).toEqual(["maxTurns:true", "maxTurns:true"]);
  });

  test("records no-op changes without mutating state", () => {
    const tweaks = new RuntimeTweaks();
    const record = tweaks.set("showReasoning", true);

    expect(record.changed).toBe(false);
    expect(record.previousValue).toBe(true);
    expect(record.nextValue).toBe(true);
    expect(tweaks.snapshot().history).toHaveLength(1);
    expect(tweaks.formatStatus()).toBe("runtime tweaks: default");
  });
});
