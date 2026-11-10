// What every sync step needs besides the bindings: the injected IO (a fake
// fetch in tests, nothing real is ever called from a test), the clock and the
// isolate's Basecamp rate limiter; and the Basecamp clients built from them.
//
// Tokens never come from here: writes use the acting user's own token
// (`withUserToken`), background reads the service token (`withServiceToken`),
// both from src/basecamp-link (spec §3).

import { createBasecampClient } from '@naf-sheets/basecamp'
import type { BasecampClient, CacheEntry, ConditionalCache, RateLimiter } from '@naf-sheets/basecamp'
import { isolateLimiter, linkContextFor } from '../basecamp-link'
import type { BasecampLinkEnv, HttpFetch, LinkContext } from '../basecamp-link'
import type { Env } from '../env'

export interface SyncDeps {
  fetch: HttpFetch
  /** Milliseconds since the epoch. */
  now: () => number
  limiter: RateLimiter
  sleep?: (ms: number) => Promise<void>
}

/** The Worker's own IO: global fetch, the clock, one limiter per isolate. */
export function defaultSyncDeps(): SyncDeps {
  return { fetch: (url, init) => fetch(url, init), now: Date.now, limiter: isolateLimiter() }
}

/** The bindings of src/basecamp-link on top of `Env`. */
export type SyncEnv = BasecampLinkEnv

export function asSyncEnv(env: Env): SyncEnv {
  return env as SyncEnv
}

/** Throws `LinkFailure('not_configured')` when a Basecamp binding is missing. */
export function syncContext(env: Env, deps: SyncDeps): LinkContext {
  return linkContextFor(asSyncEnv(env), { fetch: deps.fetch, now: deps.now, limiter: deps.limiter, sleep: deps.sleep })
}

/**
 * For queue consumers: no retry inside the Worker. A 429 or a 5xx is thrown
 * at once and the message is retried by the queue (`message.retry` with the
 * server's `Retry-After`, or exponential backoff), so a consumer never sleeps
 * and the attempt count stays the queue's (spec §9.2.8–9).
 */
export function queueClient(ctx: LinkContext): BasecampClient {
  return createBasecampClient({
    accountId: ctx.config.accountId,
    fetch: ctx.fetch,
    limiter: ctx.limiter,
    sleep: ctx.sleep,
    now: ctx.now,
    retry: { maxServerErrorAttempts: 1, maxRateLimitAttempts: 1 },
  })
}

/**
 * For reconciliation and request handlers: the client's own retries, and
 * conditional GET through `cache` when given (§9.4).
 */
export function readClient(ctx: LinkContext, cache?: ConditionalCache): BasecampClient {
  return createBasecampClient({
    accountId: ctx.config.accountId,
    fetch: ctx.fetch,
    limiter: ctx.limiter,
    sleep: ctx.sleep,
    now: ctx.now,
    cache,
  })
}

const ETAG_PREFIX = 'sync-etag:'
/** ETags older than this are dropped by KV; a miss only costs one full read. */
const ETAG_TTL_SECONDS = 30 * 24 * 3600

/**
 * The reconciliation's ETag cache in KV `SETTINGS`. Keys are the client's
 * `basecamp:<scope>:<url>` (never a token); values are the cached page.
 */
export function kvConditionalCache(kv: KVNamespace): ConditionalCache {
  return {
    async get(key: string): Promise<CacheEntry | null> {
      const raw = await kv.get(ETAG_PREFIX + key)
      if (raw === null) return null
      try {
        return JSON.parse(raw) as CacheEntry
      } catch {
        return null
      }
    },
    async put(key: string, entry: CacheEntry): Promise<void> {
      await kv.put(ETAG_PREFIX + key, JSON.stringify(entry), { expirationTtl: ETAG_TTL_SECONDS })
    },
  }
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}
