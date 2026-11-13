/**
 * Rate limiting for the one unauthenticated endpoint that costs money per
 * call: /verify fetches a third-party log and re-reads payments off the chain.
 *
 * An in-process fixed-window bucket per key. It is deliberately simple: it
 * does not pretend to be a distributed limiter, it just keeps a single
 * instance from being used as an open fetch relay, and it makes the cost
 * ceiling visible in one file. On a multi-instance deployment, front it with
 * the edge limiter and keep this as the second line.
 */
export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window closes; only meaningful when ok is false. */
  retryAfterSeconds: number;
  /** Remaining requests in the current window. */
  remaining: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Pruning keeps the map from growing without bound on long-lived processes.
const PRUNE_EVERY = 256;
let allowCalls = 0;

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function allow(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  allowCalls += 1;
  if (allowCalls % PRUNE_EVERY === 0) prune(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0, remaining: limit - 1 };
  }
  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  bucket.count += 1;
  return { ok: true, retryAfterSeconds: 0, remaining: limit - bucket.count };
}

/** Test hook: empties every bucket. Never called by the app. */
export function resetRateLimits(): void {
  buckets.clear();
  allowCalls = 0;
}
