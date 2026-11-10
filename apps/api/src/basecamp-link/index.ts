// Basecamp account linking (spec §3, §7.3, §9.5, §14; Appendix A-2, A-7).
//
// Wiring (one line, in src/index.ts after `createApp()` — not inside
// `createApp`, so tests that build their own app keep their fake fetch):
//
//   const app = createApp()
//   registerBasecampLinkRoutes(app)
//
// Bindings it reads on top of `Env`: `BasecampLinkBindings` (./env.ts).

import type { Hono } from 'hono'
import { env as workerEnv } from 'cloudflare:workers'
import { createBasecampLimiter } from '@naf-sheets/basecamp'
import type { RateLimiter } from '@naf-sheets/basecamp'
import type { AppEnv } from '../auth'
import { gateLimiter } from '../basecamp-rate-gate'
import type { GateNamespace } from '../basecamp-rate-gate'
import type { Env } from '../env'
import type { BasecampLinkDeps, BasecampLinkEnv, HttpFetch, LinkContext } from './env'
import { linkConfig } from './env'
import { basecampApiRoutes, basecampAuthRoutes, peopleMatchRoutes } from './routes'

export type { BasecampLinkBindings, BasecampLinkConfig, BasecampLinkDeps, BasecampLinkEnv, HttpFetch, LinkContext } from './env'
export { linkConfig }
export { LINK_MESSAGES, LinkFailure, type LinkErrorKey } from './errors'
export { matchByEmail, PEOPLE_CACHE_TTL_MS, refreshAccountPeople, usableEmail } from './people'
export { activeUserLink, basecampClient, REFRESH_MARGIN_MS, withServiceToken, withUserToken } from './store'

export interface BasecampLinkOptions {
  /** Default: the Worker's `fetch`. Tests pass a fake; nothing real is ever called from a test. */
  fetch?: HttpFetch
  /** Default: `Date.now`. */
  now?: () => number
  /** Default: one limiter per isolate (`isolateLimiter`: 45 requests in any 10 s). */
  limiter?: RateLimiter
  /** Backoff sleep of the Basecamp client. */
  sleep?: (ms: number) => Promise<void>
}

let sharedLimiter: RateLimiter | null = null

/**
 * The Basecamp rate limiter (spec §9.2.9): 45 requests in any 10 s. With the
 * `BASECAMP_RATE_GATE` Durable Object bound (wrangler.toml), every slot comes
 * from that one gate, so all isolates together stay under the limit; without
 * it (a test env), from this isolate's own window. Anything else in this
 * Worker that calls Basecamp should take this same instance.
 */
export function isolateLimiter(): RateLimiter {
  if (sharedLimiter) return sharedLimiter
  const local = createBasecampLimiter()
  const gate = (workerEnv as Partial<Env>).BASECAMP_RATE_GATE
  sharedLimiter = gate ? gateLimiter(gate as unknown as GateNamespace, { fallback: local }) : local
  return sharedLimiter
}

const REGISTERED = Symbol.for('naf-sheets.basecamp-link.registered')

/**
 * Adds the Basecamp link routes to an app built by `createApp`. They must be
 * registered after `createApp` has installed the auth guard, which it does
 * before returning. Registering twice on one app throws: the first set would
 * otherwise shadow the second (and its `fetch`).
 */
export function registerBasecampLinkRoutes(app: Hono<AppEnv>, options: BasecampLinkOptions = {}): void {
  const marked = app as unknown as Record<symbol, boolean>
  if (marked[REGISTERED]) throw new Error('Basecamp link routes are already registered on this app')
  marked[REGISTERED] = true

  const deps = linkDeps(options)
  app.route('/auth/basecamp', basecampAuthRoutes(deps))
  app.route('/api/basecamp', basecampApiRoutes(deps))
  app.route('/api/admin/people-matches', peopleMatchRoutes(deps))
}

function linkDeps(options: BasecampLinkOptions): BasecampLinkDeps {
  return {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    now: options.now ?? Date.now,
    limiter: options.limiter ?? isolateLimiter(),
    sleep: options.sleep,
  }
}

/**
 * A context outside a request — for the queue consumer (`withUserToken`: the
 * acting user's own token, §3) and the cron (`withServiceToken`,
 * `refreshAccountPeople`). Throws `LinkFailure('not_configured')` when a
 * binding is missing.
 */
export function linkContextFor(env: BasecampLinkEnv, options: BasecampLinkOptions = {}): LinkContext {
  return { ...linkDeps(options), db: env.DB, kv: env.SETTINGS, config: linkConfig(env) }
}
