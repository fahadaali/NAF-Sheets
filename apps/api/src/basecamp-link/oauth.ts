// Launchpad OAuth 2.0 — Basecamp's authorisation server — "web_server" flow
// (spec §3: one app registered at Launchpad, each user links their own account).
//
// Checked on 2026-11-10 against:
//   - github.com/basecamp/api sections/authentication.md (master): the three
//     URLs below, `type=web_server` / `type=refresh`, 2-week access tokens,
//     refresh tokens issued, authorization.json (`expires_at`, `identity`,
//     `accounts[]` with `product` and `id`), and the warning that Launchpad
//     does not verify email addresses (so its `identity` is never used to
//     decide who someone is — /my/profile.json in the account is);
//   - github.com/basecamp/bc-api README "Authentication" (points to the guide);
//   - github.com/basecamp/basecamp-sdk typescript/src/oauth/{authorize,exchange}.ts
//     (main): the official client's Launchpad "legacy format" — a form-encoded
//     POST body, `state` on the authorisation URL, the token response fields
//     `access_token` / `refresh_token` / `expires_in`, and how a refusal is told
//     apart from an outage.
//
// No token, code or secret is ever logged or put in an error message.

import { DEFAULT_USER_AGENT } from '@naf-sheets/basecamp'
import type { BasecampLinkDeps } from './env'

export const LAUNCHPAD_AUTHORIZE_URL = 'https://launchpad.37signals.com/authorization/new'
export const LAUNCHPAD_TOKEN_URL = 'https://launchpad.37signals.com/authorization/token'
export const LAUNCHPAD_AUTHORIZATION_URL = 'https://launchpad.37signals.com/authorization.json'

/** Where Launchpad sends the browser back. Registered at Launchpad as `https://<platform origin>/auth/basecamp/callback`. */
export const CALLBACK_PATH = '/auth/basecamp/callback'

/** Launchpad's product name for Basecamp accounts in authorization.json (Basecamp 3 and later). */
export const BASECAMP_PRODUCT = 'bc3'

/**
 * The authorisation URL. `type`, `client_id` and `redirect_uri` are the
 * documented parameters; `state` is OAuth's CSRF value (draft 5, which
 * Launchpad implements, and the official SDK sends it).
 * OPEN: that Launchpad echoes `state` unchanged is not written in the guide;
 * the live test must confirm it (without it every link is refused, which is
 * the safe failure). apps/api/OPEN_QUESTIONS.md "Basecamp link" B3.
 */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(LAUNCHPAD_AUTHORIZE_URL)
  url.searchParams.set('type', 'web_server')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

export interface TokenSet {
  accessToken: string
  /** Launchpad may leave it out of a refresh answer; the caller keeps the previous one then. */
  refreshToken: string | null
  /** Epoch milliseconds, or null when Launchpad did not say. */
  expiresAt: number | null
}

/**
 * - `refused`: the grant is invalid, expired or revoked (401, or
 *   `invalid_grant` / `access_denied` / `unauthorized_client`). A refresh
 *   refused this way marks the link `expired` (spec §3).
 * - `client_rejected`: `invalid_client` — the platform's own client id or
 *   secret is wrong. Never blamed on the user's link.
 * - `unavailable`: anything else (network, 5xx, 429, an unexpected redirect or
 *   body). Nothing changes; the caller may try again.
 */
export type LaunchpadFailureKind = 'refused' | 'client_rejected' | 'unavailable'

export class LaunchpadError extends Error {
  override readonly name = 'LaunchpadError'
  readonly kind: LaunchpadFailureKind
  readonly status: number | null
  /** OAuth `error` code from the body when it is a plain code (e.g. `invalid_grant`). */
  readonly oauthError: string | null

  constructor(kind: LaunchpadFailureKind, status: number | null, oauthError: string | null) {
    super(`launchpad ${kind} (${status === null ? 'no response' : status}${oauthError ? `, ${oauthError}` : ''})`)
    this.kind = kind
    this.status = status
    this.oauthError = oauthError
  }
}

const REFUSAL_CODES = new Set(['invalid_grant', 'access_denied', 'unauthorized_client'])
const MAX_LIFETIME_SECONDS = 10 * 366 * 24 * 3600

/** Trade the verification code for tokens (`type=web_server`). */
export async function exchangeCode(
  deps: Pick<BasecampLinkDeps, 'fetch' | 'now'>,
  client: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<TokenSet> {
  return tokenRequest(deps, {
    type: 'web_server',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    client_secret: client.clientSecret,
    code,
  })
}

/** A new access token from a refresh token (`type=refresh`). */
export async function refreshTokens(
  deps: Pick<BasecampLinkDeps, 'fetch' | 'now'>,
  client: { clientId: string; clientSecret: string },
  refreshToken: string,
): Promise<TokenSet> {
  return tokenRequest(deps, {
    type: 'refresh',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  })
}

/**
 * The guide shows the parameters in the POST URL's query string; the official
 * SDK sends the same parameters as a form-encoded body. The body is used so
 * the client secret and the code never appear in a URL (proxies, logs).
 * OPEN: confirm at the live test that Launchpad accepts the body form
 * (apps/api/OPEN_QUESTIONS.md "Basecamp link" B4).
 */
async function tokenRequest(deps: Pick<BasecampLinkDeps, 'fetch' | 'now'>, params: Record<string, string>): Promise<TokenSet> {
  let response: Response
  try {
    response = await deps.fetch(LAUNCHPAD_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
      // Never re-POST the secret to wherever a redirect points.
      redirect: 'manual',
    })
  } catch {
    throw new LaunchpadError('unavailable', null, null)
  }

  const text = await safeText(response)
  if (response.status < 200 || response.status >= 300) throw classifyRefusal(response.status, text)

  const body = parseObject(text)
  // A 2xx that is not a token answer: never echo the body (it may hold a token).
  if (!body) throw new LaunchpadError('unavailable', response.status, null)
  const accessToken = body['access_token']
  const refreshToken = body['refresh_token']
  const expiresIn = body['expires_in']
  if (typeof accessToken !== 'string' || !isTokenText(accessToken)) throw new LaunchpadError('unavailable', response.status, null)
  if (refreshToken !== undefined && refreshToken !== null && (typeof refreshToken !== 'string' || !isTokenText(refreshToken))) {
    throw new LaunchpadError('unavailable', response.status, null)
  }
  if (
    expiresIn !== undefined &&
    expiresIn !== null &&
    (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_LIFETIME_SECONDS)
  ) {
    throw new LaunchpadError('unavailable', response.status, null)
  }
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : null,
    expiresAt: typeof expiresIn === 'number' ? deps.now() + expiresIn * 1000 : null,
  }
}

export interface LaunchpadAuthorization {
  /** Epoch milliseconds, or null. */
  expiresAt: number | null
  accounts: Array<{ product: string; id: number }>
}

/** `GET authorization.json`: the accounts this token reaches and when it expires. */
export async function readAuthorization(deps: Pick<BasecampLinkDeps, 'fetch'>, accessToken: string): Promise<LaunchpadAuthorization> {
  let response: Response
  try {
    response = await deps.fetch(LAUNCHPAD_AUTHORIZATION_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': DEFAULT_USER_AGENT },
      // Never follow a redirect with the Authorization header attached.
      redirect: 'manual',
    })
  } catch {
    throw new LaunchpadError('unavailable', null, null)
  }
  const text = await safeText(response)
  if (response.status === 401) throw new LaunchpadError('refused', 401, null)
  if (response.status < 200 || response.status >= 300) throw new LaunchpadError('unavailable', response.status, null)
  const body = parseObject(text)
  if (!body) throw new LaunchpadError('unavailable', response.status, null)

  const accounts: LaunchpadAuthorization['accounts'] = []
  if (Array.isArray(body['accounts'])) {
    for (const entry of body['accounts']) {
      if (typeof entry !== 'object' || entry === null) continue
      const { product, id } = entry as { product?: unknown; id?: unknown }
      if (typeof product === 'string' && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) accounts.push({ product, id })
    }
  }
  const expiresText = body['expires_at']
  const expiresAt = typeof expiresText === 'string' && !Number.isNaN(Date.parse(expiresText)) ? Date.parse(expiresText) : null
  return { expiresAt, accounts }
}

function classifyRefusal(status: number, text: string): LaunchpadError {
  const body = parseObject(text)
  const raw = body ? body['error'] : undefined
  // Only a plain code is kept (it is logged); anything else is dropped.
  const code = typeof raw === 'string' && /^[a-z_]{1,64}$/.test(raw) ? raw : null
  if (code === 'invalid_client') return new LaunchpadError('client_rejected', status, code)
  if (status === 401 || (code !== null && REFUSAL_CODES.has(code))) return new LaunchpadError('refused', status, code)
  // OPEN: Launchpad's exact answer for a revoked refresh token is undocumented;
  // a 4xx without a recognised code is treated as an outage, never as expiry
  // (apps/api/OPEN_QUESTIONS.md "Basecamp link" B5).
  return new LaunchpadError('unavailable', status, code)
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Printable ASCII without spaces: what an Authorization header can carry. */
function isTokenText(value: string): boolean {
  return /^[\x21-\x7e]{1,4096}$/.test(value)
}
