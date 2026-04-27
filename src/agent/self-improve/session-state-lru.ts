/**
 * Generic LRU map for session-keyed state.
 *
 * Wave 10 P1 R5: bounds long-running TUI session-state Maps that previously
 * grew without limit. Mirrors the cap-100 / insertion-order eviction pattern
 * already used by `applied-skill-registry.ts`.
 */

const DEFAULT_CAP = 100;

export class SessionStateLRU<T> {
  private readonly cap: number;
  private readonly store = new Map<string, T>();

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  get(sessionId: string): T | undefined {
    return this.store.get(sessionId);
  }

  set(sessionId: string, value: T): void {
    // Refresh LRU order by re-inserting.
    if (this.store.has(sessionId)) this.store.delete(sessionId);
    this.store.set(sessionId, value);
    // Evict oldest while over cap.
    while (this.store.size > this.cap) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  delete(sessionId: string): boolean {
    return this.store.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.store.has(sessionId);
  }

  size(): number {
    return this.store.size;
  }

  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  values(): IterableIterator<T> {
    return this.store.values();
  }

  clear(): void {
    this.store.clear();
  }
}
