/**
 * Best-effort in-memory sliding-window limiter for request throttling.
 * Scope: one server instance. Costly operations (scans, AI) are additionally
 * protected by the database-backed usage meter, which is global.
 */
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    for (const [k, v] of buckets) if (!v.length || v[v.length - 1] < now - 10 * 60_000) buckets.delete(k);
    lastSweep = now;
  }
  const arr = (buckets.get(key) ?? []).filter((t) => t > now - windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)) };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, retryAfterSeconds: 0 };
}

export function __resetRateLimitsForTests() {
  buckets.clear();
}
