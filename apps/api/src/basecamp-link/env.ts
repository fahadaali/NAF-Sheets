// Bindings the Basecamp link needs on top of `Env` (src/env.ts), and the
// dependencies a test can replace (fetch, clock, limiter).
//
// Secrets only through `wrangler secret put …`; never in a file, a log or a
// response. `BASECAMP_ACCOUNT_ID` is a plain [vars] value.

import type { FetchLike, RateLimiter } from '@naf-sheets/basecamp'
import type { Env } from '../env'
import { LinkFailure } from './errors'

export interface BasecampLinkBindings {
  /** Secret: the Launchpad integration's client id (launchpad.37signals.com/integrations). */
  BASECAMP_CLIENT_ID?: string
  /** Secret: the Launchpad integration's client secret. */
  BASECAMP_CLIENT_SECRET?: string
  /** Secret: 32 random bytes, base64 — the AES-GCM key of src/crypto.ts. */
  TOKEN_ENCRYPTION_KEY?: string
  /**
   * Var: NAF's Basecamp account id — the `bc3` entry of Launchpad's
   * authorization.json that every link must reach. A person may belong to
   * several accounts; the platform works in this one only.
   */
  BASECAMP_ACCOUNT_ID?: string
}

/** `Env` extended with the link's bindings. Every field is optional so a missing one is reported, not assumed. */
export type BasecampLinkEnv = Env & BasecampLinkBindings

export interface BasecampLinkConfig {
  clientId: string
  clientSecret: string
  encryptionKey: string
  accountId: number
}

/** The configuration, or 503 `not_configured` naming nothing secret. */
export function linkConfig(env: BasecampLinkEnv): BasecampLinkConfig {
  const clientId = env.BASECAMP_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.BASECAMP_CLIENT_SECRET?.trim() ?? ''
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY?.trim() ?? ''
  const accountText = env.BASECAMP_ACCOUNT_ID?.trim() ?? ''
  const accountId = /^[1-9]\d{0,15}$/.test(accountText) ? Number(accountText) : NaN
  const keyOk = isAesKey(encryptionKey)
  if (clientId === '' || clientSecret === '' || !keyOk || !Number.isSafeInteger(accountId)) {
    // Which one is missing is an operator's question; the names are not secret.
    const missing = [
      clientId === '' && 'BASECAMP_CLIENT_ID',
      clientSecret === '' && 'BASECAMP_CLIENT_SECRET',
      !keyOk && 'TOKEN_ENCRYPTION_KEY (32 bytes, base64)',
      !Number.isSafeInteger(accountId) && 'BASECAMP_ACCOUNT_ID',
    ].filter(Boolean)
    console.error(`basecamp-link: not configured (${missing.join(', ')})`)
    throw new LinkFailure('not_configured')
  }
  return { clientId, clientSecret, encryptionKey, accountId }
}

/** 32 bytes once base64-decoded, as src/crypto.ts requires. Never logged. */
function isAesKey(keyBase64: string): boolean {
  try {
    return keyBase64 !== '' && atob(keyBase64).length === 32
  } catch {
    return false
  }
}

/** `fetch` as the Worker has it; also satisfies the Basecamp client's `FetchLike`. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>

export interface BasecampLinkDeps {
  fetch: HttpFetch
  /** Milliseconds since the epoch. */
  now: () => number
  /** One per isolate, shared by every Basecamp client built here. */
  limiter: RateLimiter
  sleep?: (ms: number) => Promise<void>
}

/** Everything a request handler needs, resolved once per request. */
export interface LinkContext extends BasecampLinkDeps {
  db: D1Database
  kv: KVNamespace
  config: BasecampLinkConfig
}

// Compile-time check that the platform fetch type is what the client expects.
const _fetchIsFetchLike = (f: HttpFetch): FetchLike => f
void _fetchIsFetchLike
