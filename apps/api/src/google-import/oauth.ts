// Google OAuth 2.0 for web server apps, for the importing user only
// (https://developers.google.com/identity/protocols/oauth2/web-server).
//
// What is stored, and for how long (spec §14 "store as little as possible"):
//   - `google-oauth-state:<sha256(state)>` → { userId, next }, 10 minutes,
//     single use. The state is bound to the signed-in user: the callback runs
//     behind naf-auth too and refuses a state started by someone else.
//   - `google-token:<userId>` → AES-GCM (../crypto.ts, aad `google:<userId>`)
//     of { accessToken, expiresAt, scope }, with a KV TTL ending 60 s before
//     the token does. `access_type=online`: Google issues no refresh token,
//     and one that arrives anyway is dropped unread.
//   - `google-link:<userId>` → { linkedAt, expiresAt }, no secret, so an
//     expired link reads `expired` rather than `unlinked`.
// Tokens are never logged, audited or returned.

import { safeNext } from 'naf-auth'
import type { Env } from '../env'
import { decryptJson, encryptJson } from '../crypto'
import type { FetchLike, GoogleConfig } from './config'
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  KV_LINK_PREFIX,
  KV_MIN_TTL_SECONDS,
  KV_STATE_PREFIX,
  KV_TOKEN_PREFIX,
  LINK_MARKER_TTL_SECONDS,
  SHEETS_READONLY_SCOPE,
  STATE_TTL_SECONDS,
  TOKEN_EXPIRY_MARGIN_SECONDS,
} from './config'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomState(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

/** aad of a user's encrypted Google token: the ciphertext only decrypts for this user and purpose. */
export function tokenAad(userId: string): string {
  return `google:${userId}`
}

export const stateKey = async (state: string): Promise<string> => `${KV_STATE_PREFIX}${await sha256Hex(state)}`
export const tokenKey = (userId: string): string => `${KV_TOKEN_PREFIX}${userId}`
export const linkKey = (userId: string): string => `${KV_LINK_PREFIX}${userId}`

// ---------------------------------------------------------------------------
// Authorization request (step 1–2)
// ---------------------------------------------------------------------------

export interface PendingState {
  userId: string
  /** Already passed through naf-auth's safeNext. */
  next: string
  createdAt: string
}

/** Creates and stores a single-use state for `userId`; returns the raw state. */
export async function createState(env: Env, userId: string, nextParam: unknown): Promise<string> {
  const state = randomState()
  const record: PendingState = { userId, next: safeNext(nextParam), createdAt: new Date().toISOString() }
  await env.SETTINGS.put(await stateKey(state), JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS })
  return state
}

/**
 * Reads and consumes a state. Returns null when it is unknown, expired, or
 * malformed. Consumed before any check so it can never be replayed.
 */
export async function consumeState(env: Env, state: string | undefined): Promise<PendingState | null> {
  if (!state || !/^[0-9a-f]{64}$/.test(state)) return null
  const key = await stateKey(state)
  const raw = await env.SETTINGS.get(key)
  if (raw === null) return null
  await env.SETTINGS.delete(key)
  try {
    const parsed = JSON.parse(raw) as Partial<PendingState>
    if (typeof parsed.userId !== 'string' || typeof parsed.next !== 'string') return null
    return { userId: parsed.userId, next: safeNext(parsed.next), createdAt: String(parsed.createdAt ?? '') }
  } catch {
    return null
  }
}

/**
 * Only documented parameters: client_id, redirect_uri, response_type=code,
 * scope, access_type, state. Not sent: include_granted_scopes (would widen
 * the token to scopes granted earlier), prompt, login_hint.
 */
export function authorizationUrl(config: GoogleConfig, redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SHEETS_READONLY_SCOPE)
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('state', state)
  return url.toString()
}

// ---------------------------------------------------------------------------
// Code exchange (step 5) and token storage
// ---------------------------------------------------------------------------

export interface StoredGoogleToken {
  accessToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  scope: string
}

export type ExchangeOutcome = { ok: true; token: StoredGoogleToken; expiresInSeconds: number } | { ok: false; reason: 'failed' | 'scope' }

/**
 * POST https://oauth2.googleapis.com/token with code, client_id,
 * client_secret, redirect_uri and grant_type=authorization_code. The granted
 * scopes are checked ("Your app must verify which scopes were actually
 * granted"): without spreadsheets.readonly nothing is stored.
 */
export async function exchangeCode(fetcher: FetchLike, config: GoogleConfig, redirectUri: string, code: string, timeoutMs: number): Promise<ExchangeOutcome> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  let response: Response
  try {
    response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (!response.ok) {
    // The error body (`error`, `error_description`) is not logged: it may echo the code.
    console.warn(`google token exchange: HTTP ${response.status}`)
    await response.body?.cancel()
    return { ok: false, reason: 'failed' }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = (await response.json()) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'failed' }
  }
  // `refresh_token`, if any, is deliberately never read.
  const accessToken = parsed.access_token
  const expiresIn = parsed.expires_in
  const tokenType = parsed.token_type
  const scope = parsed.scope
  if (typeof accessToken !== 'string' || accessToken === '') return { ok: false, reason: 'failed' }
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') return { ok: false, reason: 'failed' }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return { ok: false, reason: 'failed' }
  // Scopes are "space-delimited, case-sensitive strings". A response without
  // `scope` is treated as not granted.
  if (typeof scope !== 'string' || !scope.split(' ').includes(SHEETS_READONLY_SCOPE)) return { ok: false, reason: 'scope' }
  // Too short-lived to be stored in KV (minimum TTL) after the safety margin.
  if (expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS < KV_MIN_TTL_SECONDS) return { ok: false, reason: 'failed' }

  return {
    ok: true,
    expiresInSeconds: expiresIn,
    token: { accessToken, expiresAt: Date.now() + expiresIn * 1000, scope: SHEETS_READONLY_SCOPE },
  }
}

export async function storeToken(env: Env, encryptionKey: string, userId: string, token: StoredGoogleToken, expiresInSeconds: number): Promise<void> {
  const sealed = await encryptJson(encryptionKey, token, tokenAad(userId))
  await env.SETTINGS.put(tokenKey(userId), sealed, { expirationTtl: expiresInSeconds - TOKEN_EXPIRY_MARGIN_SECONDS })
  await env.SETTINGS.put(linkKey(userId), JSON.stringify({ linkedAt: new Date().toISOString(), expiresAt: new Date(token.expiresAt).toISOString() }), {
    expirationTtl: LINK_MARKER_TTL_SECONDS,
  })
}

/**
 * Google refused the token (revoked): drop it so the link reads `expired`; the
 * marker stays. The only deletes in this module are this dead credential and
 * a consumed OAuth state. OPEN: no unlink/revoke route in the contract (G16).
 */
export async function discardToken(env: Env, userId: string): Promise<void> {
  await env.SETTINGS.delete(tokenKey(userId))
}

export type LinkState = { state: 'active'; token: StoredGoogleToken } | { state: 'expired' } | { state: 'unlinked' }

/** The user's usable token, or why there is none. */
export async function loadLink(env: Env, encryptionKey: string, userId: string): Promise<LinkState> {
  const sealed = await env.SETTINGS.get(tokenKey(userId))
  if (sealed !== null) {
    try {
      const token = await decryptJson<StoredGoogleToken>(encryptionKey, sealed, tokenAad(userId))
      // KV expiry is not instant: the stored expiry decides.
      if (typeof token.accessToken === 'string' && token.expiresAt - TOKEN_EXPIRY_MARGIN_SECONDS * 1000 > Date.now()) {
        return { state: 'active', token }
      }
    } catch {
      // Key rotated or value tampered with: unusable, the user relinks.
    }
    return { state: 'expired' }
  }
  return (await env.SETTINGS.get(linkKey(userId))) !== null ? { state: 'expired' } : { state: 'unlinked' }
}

// ---------------------------------------------------------------------------
// Callback redirect
// ---------------------------------------------------------------------------

export type CallbackError = 'denied' | 'scope' | 'failed'

/**
 * `next` with `google_error=<reason>` appended, textually: parsing it as a URL
 * would normalise `/.//host` into `//host`, a different origin. The result is
 * checked with safeNext once more.
 * OPEN: the web app must read `google_error` (OPEN_QUESTIONS.md "Google import" G11).
 */
export function nextWithError(next: string, reason: CallbackError): string {
  const hashAt = next.indexOf('#')
  const base = hashAt === -1 ? next : next.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : next.slice(hashAt)
  const joined = `${base}${base.includes('?') ? '&' : '?'}google_error=${reason}${hash}`
  return safeNext(joined)
}
