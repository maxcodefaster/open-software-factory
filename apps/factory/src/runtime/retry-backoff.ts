// Spaces repeated retries of background work that keeps failing. In-memory
// only: a restart retries at once, and nothing here replaces persisted intent.
export function createRetryBackoff(
  baseMS: number,
  maxMS: number,
  now: () => number = () => performance.now(),
) {
  const failures = new Map<string, { count: number; until: number }>();
  return {
    due(key: string) {
      const held = failures.get(key);
      return !held || now() >= held.until;
    },
    failed(key: string) {
      const count = (failures.get(key)?.count ?? 0) + 1;
      failures.set(key, { count, until: now() + Math.min(maxMS, baseMS * 2 ** (count - 1)) });
    },
    succeeded(key: string) {
      failures.delete(key);
    },
  };
}
export type RetryBackoff = ReturnType<typeof createRetryBackoff>;
