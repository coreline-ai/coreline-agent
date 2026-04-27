/**
 * Unit tests for SessionStateLRU (Wave 10 P1 R5).
 */

import { describe, expect, test } from "bun:test";
import { SessionStateLRU } from "../src/agent/self-improve/session-state-lru.js";

describe("SessionStateLRU", () => {
  test("get/set roundtrip", () => {
    const lru = new SessionStateLRU<number>(10);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
  });

  test("eviction at cap", () => {
    const lru = new SessionStateLRU<number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.size()).toBe(3);
    lru.set("d", 4); // evicts "a"
    expect(lru.size()).toBe(3);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("d")).toBe(true);
  });

  test("re-set refreshes LRU order", () => {
    const lru = new SessionStateLRU<number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.set("a", 99); // refreshes "a" to most-recent
    lru.set("d", 4); // should evict "b" (oldest), not "a"
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.get("a")).toBe(99);
  });

  test("delete + has", () => {
    const lru = new SessionStateLRU<number>(10);
    lru.set("a", 1);
    expect(lru.has("a")).toBe(true);
    expect(lru.delete("a")).toBe(true);
    expect(lru.has("a")).toBe(false);
    expect(lru.delete("a")).toBe(false); // already deleted
  });

  test("clear", () => {
    const lru = new SessionStateLRU<number>(10);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size()).toBe(0);
    expect(lru.has("a")).toBe(false);
  });
});
