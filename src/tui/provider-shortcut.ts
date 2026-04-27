/**
 * Provider switching keyboard shortcuts — pure helpers for unit testing.
 *
 * Ctrl+N / Ctrl+B → cycle next/previous provider
 * Ctrl+1..9       → jump to N-th provider directly
 */

/** Resolve "next" provider name given current + list. Returns null if unchanged. */
export function resolveCycleProvider(
  providers: string[],
  current: string,
  direction: "next" | "previous",
): string | null {
  if (providers.length < 2) return null;
  const idx = providers.indexOf(current);
  const safeIdx = idx === -1 ? 0 : idx;
  const nextIdx = direction === "next"
    ? (safeIdx + 1) % providers.length
    : (safeIdx - 1 + providers.length) % providers.length;
  const next = providers[nextIdx];
  return next !== undefined && next !== current ? next : null;
}

/** Resolve N-th provider (1-indexed from user input "1".."9"). */
export function resolveNumericProvider(
  providers: string[],
  input: string,
): string | null {
  if (!/^[1-9]$/.test(input)) return null;
  const idx = parseInt(input, 10) - 1;
  if (idx >= providers.length) return null;
  return providers[idx] ?? null;
}
