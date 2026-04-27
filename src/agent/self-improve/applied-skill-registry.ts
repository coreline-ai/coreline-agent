/**
 * In-memory LRU registry of active skill selections per sessionId.
 *
 * V2 necessity: built-in skills have no runtime hook. They are injected as
 * prompt text at selection time. To record evidence of a skill's effect on a
 * session outcome, we register the active skills when the router finishes
 * and consume them at session end.
 */

import type { SkillSelection } from "../../skills/types.js";

const REGISTRY_CAP = 100;
const registry = new Map<string, SkillSelection[]>();

/**
 * Register skills active for a session.
 *
 * **Accumulates across turns (I1 fix):** if the same sessionId already has
 * entries, new selections are MERGED by skill.id (most recent wins for
 * duplicates). This way a session spanning N turns aggregates the union of
 * all skills selected throughout, and evidence is recorded once per session
 * at session end — not once per turn.
 */
export function registerSkillSelection(
  sessionId: string,
  selections: readonly SkillSelection[],
): void {
  if (!sessionId) return;

  const existing = registry.get(sessionId) ?? [];
  // Merge by skill.id — last-seen selection wins for duplicates.
  const byId = new Map<string, SkillSelection>();
  for (const sel of existing) byId.set(sel.skill.id, sel);
  for (const sel of selections) byId.set(sel.skill.id, sel);

  // Refresh LRU order by re-inserting.
  if (registry.has(sessionId)) registry.delete(sessionId);
  registry.set(sessionId, Array.from(byId.values()));

  // Evict oldest entries when cap exceeded.
  while (registry.size > REGISTRY_CAP) {
    const oldestKey = registry.keys().next().value;
    if (oldestKey === undefined) break;
    registry.delete(oldestKey);
  }
}

/** Retrieve + clear skills for a session. Returns [] if none. */
export function consumeAppliedSkills(sessionId: string): SkillSelection[] {
  if (!sessionId) return [];
  const entry = registry.get(sessionId);
  if (!entry) return [];
  registry.delete(sessionId);
  return entry;
}

/** Current registry size (for testing). */
export function registrySize(): number {
  return registry.size;
}

/** Clear entire registry (for testing). */
export function resetRegistry(): void {
  registry.clear();
}
