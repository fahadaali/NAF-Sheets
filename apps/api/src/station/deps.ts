// What every sync step needs besides the bindings: the injected IO (a fake
// fetch in tests, nothing real is ever called from a test), the clock and the
// isolate's Basecamp rate limiter; and the Basecamp clients built from them.
//
// Tokens never come from here: every station read and write goes out with the
// sync account's token (`withServiceToken`, src/basecamp-link; CLAUDE.md §2,
// owner decision 7).

import { createBasecampClient } from '@naf-sheets/basecamp'
import type { BasecampClient, ConditionalCache, RateLimiter } from '@naf-sheets/basecamp'
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
 * The station's Basecamp client: the client's own retries (429 after
 * `Retry-After`, 5xx with backoff, never 404), and conditional GET through
 * `cache` when given (§9.4).
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
