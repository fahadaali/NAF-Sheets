// The OAuth `state` of one link attempt: random, single use, short-lived, and
// bound to the naf-id user who started it (spec §14).
//
// Bound to the session user, a state proves more than "this came from
// Launchpad": a callback is accepted only from the same signed-in user. A
// victim lured to a callback carrying an attacker's code and state is refused,
// so nobody's platform account can be linked to someone else's Basecamp
// account (login CSRF).
//
// Stored in KV (`SETTINGS`, "short-lived tokens") under the SHA-256 of the
// state, never the state itself, with a 10-minute TTL.

import { randomToken } from 'naf-auth'

export const STATE_TTL_SECONDS = 600
const KEY_PREFIX = 'bc-oauth-state:'

export interface PendingLink {
  /** members.user_id of the person who started the link. */
  userId: string
  /** Already passed through `safeNext`. */
  next: string
  /** Admin connecting the service token (`?service=1`) rather than their own link. */
  service: boolean
  /** Exactly the redirect_uri sent to Launchpad; the code exchange must repeat it. */
  redirectUri: string
  createdAt: string
}

export async function createState(kv: KVNamespace, pending: PendingLink): Promise<string> {
  const state = randomToken(32)
  await kv.put(await stateKey(state), JSON.stringify(pending), { expirationTtl: STATE_TTL_SECONDS })
  return state
}

/**
 * The pending link for `state`, consumed: a second call with the same state
 * returns null. The entry is overwritten with a tombstone, not deleted, and
 * KV's TTL removes it.
 */
export async function consumeState(kv: KVNamespace, state: string): Promise<PendingLink | null> {
  if (!/^[0-9a-f]{64}$/.test(state)) return null
  const key = await stateKey(state)
  const raw = await kv.get(key)
  if (raw === null) return null
  await kv.put(key, JSON.stringify({ consumed: true }), { expirationTtl: STATE_TTL_SECONDS })

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const p = value as Partial<PendingLink> & { consumed?: unknown }
  if (p.consumed === true) return null
  if (typeof p.userId !== 'string' || typeof p.next !== 'string' || typeof p.service !== 'boolean' || typeof p.redirectUri !== 'string') return null
  return { userId: p.userId, next: p.next, service: p.service, redirectUri: p.redirectUri, createdAt: String(p.createdAt ?? '') }
}

export async function stateKey(state: string): Promise<string> {
  return `${KEY_PREFIX}${await sha256Hex(state)}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
