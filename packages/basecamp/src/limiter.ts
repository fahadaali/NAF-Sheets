// Shared outbound rate limiter (spec §9.2.9: "a queue with a safe limit, e.g.
// 4 requests/second, shared by every operation").
//
// Basecamp's first common limit is about 50 requests per 10 seconds per IP,
// with other limits adjusted dynamically. One limiter instance is meant to be
// created once per Worker isolate and passed to every client built there, so
// all callers in that isolate draw from the same bucket.
// OPEN: an isolate-local bucket does not bound several isolates together; a
// global limit would need a Durable Object behind `RateLimiter`. See OPEN_QUESTIONS.md.

export interface RateLimiter {
  /** Resolves when the caller may send one request. Callers are served in order. */
  acquire(): Promise<void>
  /**
   * Hold every caller for `ms` (after a 429): nobody in this isolate sends
   * until it elapses, and the bucket restarts empty.
   */
  pauseFor?(ms: number): void
}

export interface TokenBucketOptions {
  /** Sustained rate. Default 4. */
  ratePerSecond?: number
  /** Bucket size: how many requests may go out back to back. Default = ratePerSecond. */
  capacity?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_RATE_PER_SECOND = 4

export function createTokenBucketLimiter(options: TokenBucketOptions = {}): RateLimiter {
  const rate = options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND
  const capacity = options.capacity ?? rate
  if (!(rate > 0) || !Number.isFinite(rate)) throw new TypeError('ratePerSecond must be a positive number')
  if (!(capacity >= 1) || !Number.isFinite(capacity)) throw new TypeError('capacity must be at least 1')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep

  let tokens = capacity
  let lastRefill = now()
  let pausedUntil = Number.NEGATIVE_INFINITY
  // FIFO: each acquire waits for the previous one to be granted.
  let tail: Promise<void> = Promise.resolve()

  const refill = (): void => {
    const t = now()
    if (t > lastRefill) {
      tokens = Math.min(capacity, tokens + ((t - lastRefill) * rate) / 1000)
      lastRefill = t
    }
  }

  const take = async (): Promise<void> => {
    for (;;) {
      const t = now()
      if (t < pausedUntil) {
        await sleep(pausedUntil - t)
        continue
      }
      refill()
      if (tokens >= 1) {
        tokens -= 1
        return
      }
      const wait = Math.max(1, Math.ceil(((1 - tokens) * 1000) / rate))
      await sleep(wait)
    }
  }

  return {
    acquire(): Promise<void> {
      const granted = tail.then(take)
      // A rejected sleep must not wedge the queue for later callers.
      tail = granted.catch(() => undefined)
      return granted
    },
    pauseFor(ms: number): void {
      if (!(ms > 0)) return
      const until = now() + ms
      if (until > pausedUntil) pausedUntil = until
      tokens = 0
      lastRefill = Math.max(lastRefill, pausedUntil)
    },
  }
}

export function defaultSleep(ms: number): Promise<void> {
  const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms)
  })
}
