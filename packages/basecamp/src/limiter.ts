// Shared outbound rate limiter (spec §9.2.9: Basecamp's first common limit is
// "about 50 requests per 10 seconds per IP"; the client applies "a safe limit
// shared by every operation").
//
// The production limiter (`createBasecampLimiter`, owner decision 2026-11-10)
// is matched to that documented window with a safety margin: at most 45
// requests in any 10-second window. It is a token bucket of 45 tokens in which
// each spent token comes back exactly 10 s after it was spent, so a burst of
// 45 goes out at once and no window of 10 s ever holds more than 45 requests
// (the earlier flat 4/s bucket allowed 44 per window, never a burst). A `429`
// with `Retry-After` still pauses everyone (`pauseFor`).
//
// One limiter instance is meant to be created once per Worker isolate and
// passed to every client built there, so all callers in that isolate draw from
// the same bucket.
// OPEN: an isolate-local bucket does not bound several isolates together; a
// global limit would need a Durable Object behind `RateLimiter`. See OPEN_QUESTIONS.md #7.

export interface RateLimiter {
  /** Resolves when the caller may send one request. Callers are served in order. */
  acquire(): Promise<void>
  /**
   * Hold every caller for `ms` (after a 429): nobody in this isolate sends
   * until it elapses, and the requests after it are paced (no burst).
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

/**
 * A plain token bucket (rate + capacity). The platform used it at 4/s until
 * 2026-11-10; production now uses `createBasecampLimiter`. Kept for callers
 * that want a flat rate.
 */
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

/** Basecamp's documented first limit (spec §9.2.9): about 50 requests per 10 s per IP. */
export const BASECAMP_DOCUMENTED_LIMIT = { requests: 50, windowMs: 10_000 } as const
/** The platform's limit: the documented window with a margin of 5 requests. */
export const BASECAMP_SAFE_LIMIT = { requests: 45, windowMs: 10_000 } as const

export interface WindowLimiterOptions {
  /** Requests allowed in any window. Default 45. */
  requests?: number
  /** Window length. Default 10,000 ms. */
  windowMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * At most `requests` grants in any `windowMs` window (any half-open interval
 * of that length): a token bucket of `requests` tokens where each token comes
 * back `windowMs` after it was spent. Bursts up to `requests` are allowed;
 * callers are served in order.
 *
 * After `pauseFor` (a 429), the bucket restarts as if its `requests` tokens
 * had been spent evenly over the last window, so the requests after a pause
 * go out one every `windowMs / requests` instead of in a burst that would
 * hit the limit again.
 */
export function createWindowLimiter(options: WindowLimiterOptions = {}): RateLimiter {
  const limit = options.requests ?? BASECAMP_SAFE_LIMIT.requests
  const windowMs = options.windowMs ?? BASECAMP_SAFE_LIMIT.windowMs
  validateWindow(limit, windowMs)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const state = newWindowState()
  // FIFO: each caller reserves its slot once the previous one was granted.
  let tail: Promise<void> = Promise.resolve()
  const take = async (): Promise<void> => {
    const t = now()
    const at = reserveSlot(state, t, limit, windowMs)
    if (at > t) await sleep(at - t)
  }
  return {
    acquire(): Promise<void> {
      const granted = tail.then(take)
      // A rejected sleep must not wedge the queue for later callers.
      tail = granted.catch(() => undefined)
      return granted
    },
    pauseFor(ms: number): void {
      pauseWindow(state, now(), ms, limit, windowMs)
    },
  }
}

function validateWindow(limit: number, windowMs: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('requests must be a positive integer')
  if (!(windowMs > 0) || !Number.isFinite(windowMs)) throw new TypeError('windowMs must be a positive number')
}

/**
 * The window's bookkeeping, shared by the in-isolate limiter and the
 * platform-wide gate (a Durable Object in apps/api): the times of the last
 * `limit` grants, oldest first (some may be in the future: reserved slots).
 */
export interface WindowState {
  spent: number[]
  pausedUntil: number
}

export function newWindowState(): WindowState {
  return { spent: [], pausedUntil: Number.NEGATIVE_INFINITY }
}

/**
 * Reserves the earliest slot at or after `now` that keeps every window of
 * `windowMs` at `limit` grants or fewer, and returns its time. Slots are
 * handed out in order (each at or after the previous one), so callers are
 * served first come, first served.
 */
export function reserveSlot(state: WindowState, now: number, limit: number, windowMs: number): number {
  validateWindow(limit, windowMs)
  const last = state.spent.length > 0 ? (state.spent[state.spent.length - 1] as number) : Number.NEGATIVE_INFINITY
  let at = Math.max(now, state.pausedUntil, last)
  // The limit-th most recent grant must be out of the window ending at `at`.
  if (state.spent.length >= limit) at = Math.max(at, (state.spent[state.spent.length - limit] as number) + windowMs)
  state.spent.push(at)
  if (state.spent.length > limit) state.spent.splice(0, state.spent.length - limit)
  return at
}

/**
 * After a 429: nobody is granted a slot before `now + ms`, and the slots
 * after it are paced as if `limit` grants had been spread evenly over the
 * window ending then (grants already made still count: only stricter).
 */
export function pauseWindow(state: WindowState, now: number, ms: number, limit: number, windowMs: number): void {
  if (!(ms > 0)) return
  const until = now + ms
  if (until > state.pausedUntil) state.pausedUntil = until
  const even = Array.from({ length: limit }, (_, i) => state.pausedUntil - windowMs + Math.ceil((i * windowMs) / limit))
  state.spent = [...state.spent, ...even].sort((a, b) => a - b).slice(-limit)
}

/**
 * The limiter every Basecamp client of the platform shares (one per isolate):
 * 45 requests in any 10 s, under Basecamp's documented 50 per 10 s.
 */
export function createBasecampLimiter(options: Pick<WindowLimiterOptions, 'now' | 'sleep'> = {}): RateLimiter {
  return createWindowLimiter({ ...BASECAMP_SAFE_LIMIT, ...options })
}

export function defaultSleep(ms: number): Promise<void> {
  const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms)
  })
}
