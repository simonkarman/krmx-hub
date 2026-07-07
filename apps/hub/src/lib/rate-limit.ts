export const TICKET_RATE_LIMIT_MAX = 10;
export const TICKET_RATE_LIMIT_WINDOW_MS = 60_000;

declare global {
  var __rateBuckets: Map<string, number[]> | undefined;
}

const buckets = (globalThis.__rateBuckets ??= new Map<string, number[]>());

/**
 * Sliding-window rate limiter (§4: ticket endpoint is rate limited; A-10).
 * In-memory is correct for Phase 0's single local process; the serverless
 * deploy (M6) must move this to shared state.
 */
export function allowRequest(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= max) {
    buckets.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  buckets.set(key, timestamps);
  return true;
}
